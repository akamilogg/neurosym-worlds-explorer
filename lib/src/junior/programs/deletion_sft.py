"""deletion@1 with SFT (SPEC-EDICION-PESOS 15.3, WE7): learns which weights of gate_proj to DELETE, as a method program
(SPEC-INVESTIGACION-EXTERNA 8) run by the host's executor under a training profile - never a worker of its own.

    inputs/job.json       its parameters (phase, backend, layers, bounds, init_fraction, epochs, batch, max_length,
                          learning_rate, beta {start, end}), its seed and limits
    inputs/dataset.jsonl  the dataset's rows: system, user parts, the memory calls and the answer
    JUNIOR_BASE           the start's checkpoint, read-only
    JUNIOR_CHECKPOINT     where it keeps its logits and step to go on from (the same job only)
    out/                  phase "capacity": capacity.json; phase "train": modules.json and each module's indices (I64),
                          out/result.json saying its format and products

What it learns: one logit per weight of gate_proj in the layers it is given (the host checks they are past the circuit's).
The mask is sigmoid(beta * s), beta rising linearly from beta.start to beta.end; at the end it is thresholded at zero (a
weight is deleted where its logit is below zero). The logits start from Wanda, |W_ij| * ||X_j||, computed on the training
data itself: centred so that `init_fraction` of each module's weights start below zero. No sparsity target: the bound on
what may be deleted is checked by the host when it imports the mask, which is no version past it.

Two backends:
  fake       the harness's imitation: pure Python, deterministic. The "model" is the base's gate_proj matrices; a row's
             inputs are vectors drawn from its answer, one per word; the loss is how much deleting changes the module's
             output on them (||(W * (1 - m)) x||^2), so the gradient keeps what matters - the contract and the arithmetic of
             the mask tested, not a language model.
  qwenputer  torch on the training GPU: the base loaded, every weight frozen, the mask applied to each target gate_proj in
             its forward, the loss the SFT loss on the answer's tokens only. Not yet run on the real machine: its GPU
             execution waits for the GPU isolation test.
"""
import hashlib
import json
import math
import os
import struct
import sys
from array import array

INPUTS, OUT = "inputs", "out"
CHECKPOINT = os.environ.get("JUNIOR_CHECKPOINT") or "checkpoint"


def read_safetensors(data):
    n = struct.unpack("<Q", data[:8])[0]
    header = json.loads(data[8:8 + n].decode("utf8"))
    header.pop("__metadata__", None)
    return {name: (e["dtype"], list(e["shape"]), data[8 + n + e["data_offsets"][0]:8 + n + e["data_offsets"][1]]) for name, e in header.items()}


def write_indices(path, indices):
    data = array("q", indices).tobytes()
    h = json.dumps({"indices": {"dtype": "I64", "shape": [len(indices)], "data_offsets": [0, len(data)]}}, separators=(",", ":"))
    while (8 + len(h.encode("utf8"))) % 8:
        h += " "
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(h.encode("utf8"))) + h.encode("utf8") + data)


def bf16_value(bits):
    return struct.unpack("<f", struct.pack("<I", (bits & 0xFFFF) << 16))[0]


def module_name(layer):
    return "model.layers.%d.mlp.gate_proj" % layer


def rows_of():
    with open(os.path.join(INPUTS, "dataset.jsonl"), encoding="utf8") as f:
        return [json.loads(l) for l in f if l.strip()]


def emit(products):
    with open(os.path.join(OUT, "result.json"), "w") as f:
        json.dump(products, f, sort_keys=True)


def save_checkpoint(state):
    os.makedirs(CHECKPOINT, exist_ok=True)
    tmp = os.path.join(CHECKPOINT, "state.json.tmp")
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, os.path.join(CHECKPOINT, "state.json"))


def load_checkpoint():
    p = os.path.join(CHECKPOINT, "state.json")
    return json.load(open(p)) if os.path.exists(p) else None


def threshold_and_write(logits_by_module):
    """Deleted where the logit is below zero; each module's indices, sorted, and modules.json."""
    listed, products = [], ["modules.json"]
    for i, (name, logits) in enumerate(sorted(logits_by_module.items())):
        idx = [k for k, s in enumerate(logits) if s < 0]
        if not idx:
            continue
        f = "m%d.safetensors" % i
        write_indices(os.path.join(OUT, f), idx)
        listed.append({"module": name, "file": f, "deleted": len(idx)})
        products.append(f)
    with open(os.path.join(OUT, "modules.json"), "w") as f:
        json.dump(listed, f)
    emit({"format": "mask@1", "products": products})


def centred(scores, fraction):
    """log(score) shifted so that `fraction` of them start below zero (ties broken by index: deterministic)."""
    logs = [math.log(s + 1e-12) for s in scores]
    k = int(math.floor(fraction * len(logs)))
    order = sorted(range(len(logs)), key=lambda i: (logs[i], i))
    if k <= 0:
        cut = logs[order[0]] - 1.0
        return [v - cut for v in logs]
    if k >= len(logs):
        cut = logs[order[-1]] + 1.0
        return [v - cut for v in logs]
    cut = 0.5 * (logs[order[k - 1]] + logs[order[k]])
    out = [v - cut for v in logs]
    # A tie at the cut: the first k by order below zero, the rest above.
    for r, i in enumerate(order):
        if r < k and out[i] >= 0:
            out[i] = -1e-9
        elif r >= k and out[i] < 0:
            out[i] = 1e-9
    return out


# --- fake ---------------------------------------------------------------------------------------------------------------

def fake_vector(text, dim):
    out, seed = [], hashlib.sha256(text.encode("utf8")).digest()
    while len(out) < dim:
        seed = hashlib.sha256(seed).digest()
        out.extend((b - 127.5) / 127.5 for b in seed)
    return out[:dim]


def fake_base_modules(layers):
    base = os.environ["JUNIOR_BASE"]
    tensors = {}
    for f in sorted(os.listdir(base)):
        if f.endswith(".safetensors"):
            tensors.update(read_safetensors(open(os.path.join(base, f), "rb").read()))
    mods = {}
    for layer in layers:
        name = module_name(layer)
        dtype, shape, data = tensors[name + ".weight"]
        if dtype != "BF16" or len(shape) != 2:
            raise SystemExit(name + " is not a bf16 matrix")
        bits = array("H")
        bits.frombytes(data)
        mods[name] = (shape, [bf16_value(b) for b in bits])
    return mods


def fake_inputs(rows, din, max_length):
    """A row's inputs to a module: one vector per word of its answer (at most max_length)."""
    out = []
    for r in rows:
        words = (r.get("answer") or "").split()[:max_length] or [""]
        out.append([fake_vector(r.get("id", "") + "#" + str(t) + "#" + w, din) for t, w in enumerate(words)])
    return out


def sigmoid(x):
    return 1.0 / (1.0 + math.exp(-x)) if x >= 0 else math.exp(x) / (1.0 + math.exp(x))


def fake_train(job, rows):
    p = job["parameters"]
    mods = fake_base_modules(p["layers"])
    state = load_checkpoint()
    if state is None or state.get("job") != job["job"]:
        logits = {}
        for name, ((dout, din), W) in mods.items():
            # Wanda on the training data: the sum of squares of each input channel.
            sumsq = [0.0] * din
            for xs in fake_inputs(rows, din, p["max_length"]):
                for x in xs:
                    for j in range(din):
                        sumsq[j] += x[j] * x[j]
            scores = [abs(W[i * din + j]) * math.sqrt(sumsq[j]) for i in range(dout) for j in range(din)]
            logits[name] = centred(scores, p["init_fraction"])
        state = {"job": job["job"], "step": 0, "logits": logits}
    batches = [rows[i:i + p["batch"]] for i in range(0, len(rows), p["batch"])]
    total = p["epochs"] * len(batches)
    while state["step"] < total:
        t = state["step"]
        beta = p["beta"]["start"] + (p["beta"]["end"] - p["beta"]["start"]) * (t / max(1, total - 1))
        batch = batches[t % len(batches)]
        for name, ((dout, din), W) in mods.items():
            s = state["logits"][name]
            grad = [0.0] * len(s)
            n = 0
            for xs in fake_inputs(batch, din, p["max_length"]):
                for x in xs:
                    n += 1
                    m = [sigmoid(beta * v) for v in s]
                    e = [sum(W[i * din + j] * (1.0 - m[i * din + j]) * x[j] for j in range(din)) for i in range(dout)]
                    for i in range(dout):
                        for j in range(din):
                            k = i * din + j
                            # d||e||^2/dm = -2 e_i W_ij x_j; dm/ds = beta m (1 - m)
                            grad[k] += -2.0 * e[i] * W[k] * x[j] * beta * m[k] * (1.0 - m[k])
            state["logits"][name] = [v - p["learning_rate"] * g / max(1, n) for v, g in zip(s, grad)]
        state["step"] = t + 1
        save_checkpoint(state)
    threshold_and_write(state["logits"])


def fake_capacity(job, rows):
    p = job["parameters"]
    mods = fake_base_modules(p["layers"])
    weights = sum(shape[0] * shape[1] for shape, _ in mods.values())
    # A logit in fp32 per weight and the optimizer's two moments: 12 bytes each.
    with open(os.path.join(OUT, "capacity.json"), "w") as f:
        json.dump({"state": "fits", "peak_bytes": 12 * weights, "weights": weights}, f)
    emit({"format": "capacity@1", "products": ["capacity.json"]})


# --- qwenputer (torch; not yet run on the real machine) -----------------------------------------------------------------

def qwen_setup(job):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    p = job["parameters"]
    torch.manual_seed(job["seed"])
    base = os.environ["JUNIOR_BASE"]
    tok = AutoTokenizer.from_pretrained(base)
    model = AutoModelForCausalLM.from_pretrained(base, torch_dtype=torch.bfloat16).cuda()
    for prm in model.parameters():
        prm.requires_grad_(False)
    targets = {}
    for layer in p["layers"]:
        name = module_name(layer)
        targets[name] = model.get_submodule(name)
    return torch, tok, model, targets


def encode(tok, row, max_length):
    """The row as the junior is asked it, and the answer's tokens: the loss on the answer only."""
    msgs = [{"role": "system", "content": row.get("system", "")}, {"role": "user", "content": "\n\n".join(row.get("user") or [])}]
    prompt = tok.apply_chat_template(msgs, add_generation_prompt=True, tokenize=True)
    answer = tok(row.get("answer", ""), add_special_tokens=False)["input_ids"]
    ids = (prompt + answer)[:max_length]
    labels = ([-100] * len(prompt) + answer)[:max_length]
    return ids, labels


def qwen_wanda(torch, tok, model, targets, rows, p):
    sums = {n: None for n in targets}
    hooks = []
    for n, mod in targets.items():
        def pre(_m, inp, n=n):
            x = inp[0][0].detach().double()
            s = (x * x).sum(dim=0)
            sums[n] = s if sums[n] is None else sums[n] + s
        hooks.append(mod.register_forward_pre_hook(pre))
    try:
        with torch.no_grad():
            for r in rows:
                ids, _ = encode(tok, r, p["max_length"])
                model(input_ids=torch.tensor([ids], device="cuda"))
    finally:
        for h in hooks:
            h.remove()
    logits = {}
    for n, mod in targets.items():
        scores = (mod.weight.detach().double().abs() * sums[n].sqrt().unsqueeze(0)).flatten().cpu().tolist()
        logits[n] = centred(scores, p["init_fraction"])
    return logits


def qwen_train(job, rows):
    torch, tok, model, targets = qwen_setup(job)
    p = job["parameters"]
    state = load_checkpoint()
    if state is None or state.get("job") != job["job"]:
        init = qwen_wanda(torch, tok, model, targets, rows, p)
        state = {"job": job["job"], "step": 0}
        S = {n: torch.tensor(init[n], device="cuda", dtype=torch.float32).reshape(mod.weight.shape) for n, mod in targets.items()}
    else:
        S = {n: torch.load(os.path.join(CHECKPOINT, n + ".pt")).cuda() for n in targets}
    for s in S.values():
        s.requires_grad_(True)
    opt = torch.optim.Adam(list(S.values()), lr=p["learning_rate"])
    beta = {"v": p["beta"]["start"]}
    originals = {}
    for n, mod in targets.items():
        W = mod.weight
        originals[n] = mod.forward

        def fwd(x, n=n, W=W):
            m = torch.sigmoid(beta["v"] * S[n]).to(W.dtype)
            return torch.nn.functional.linear(x, W * m, None)
        mod.forward = fwd
    batches = [rows[i:i + p["batch"]] for i in range(0, len(rows), p["batch"])]
    total = p["epochs"] * len(batches)
    try:
        while state["step"] < total:
            t = state["step"]
            beta["v"] = p["beta"]["start"] + (p["beta"]["end"] - p["beta"]["start"]) * (t / max(1, total - 1))
            opt.zero_grad()
            for r in batches[t % len(batches)]:
                ids, labels = encode(tok, r, p["max_length"])
                out = model(input_ids=torch.tensor([ids], device="cuda"), labels=torch.tensor([labels], device="cuda"))
                (out.loss / len(batches[t % len(batches)])).backward()
            opt.step()
            state["step"] = t + 1
            os.makedirs(CHECKPOINT, exist_ok=True)
            for n, s in S.items():
                torch.save(s.detach().cpu(), os.path.join(CHECKPOINT, n + ".pt"))
            save_checkpoint(state)
    finally:
        for n, mod in targets.items():
            mod.forward = originals[n]
    threshold_and_write({n: s.detach().flatten().cpu().tolist() for n, s in S.items()})


def qwen_capacity(job, rows):
    """One step on the longest row, its peak measured: what the run would need."""
    import torch
    torch.cuda.reset_peak_memory_stats()
    torch_, tok, model, targets = qwen_setup(job)
    p = job["parameters"]
    S = {n: torch.zeros_like(mod.weight, dtype=torch.float32, requires_grad=True) for n, mod in targets.items()}
    longest = max(rows, key=lambda r: len(r.get("answer", "")))
    ids, labels = encode(tok, longest, p["max_length"])
    for n, mod in targets.items():
        W = mod.weight
        mod.forward = (lambda x, n=n, W=W: torch.nn.functional.linear(x, W * torch.sigmoid(S[n]).to(W.dtype), None))
    out = model(input_ids=torch.tensor([ids * 1], device="cuda"), labels=torch.tensor([labels], device="cuda"))
    out.loss.backward()
    peak = int(torch.cuda.max_memory_allocated())
    total = torch.cuda.get_device_properties(0).total_memory
    # The optimizer's two moments per logit, not yet allocated by one backward.
    need = peak + 8 * sum(s.numel() for s in S.values())
    with open(os.path.join(OUT, "capacity.json"), "w") as f:
        json.dump({"state": "fits" if need < total else "does_not_fit", "peak_bytes": need, "device_bytes": int(total),
                   **({} if need < total else {"reason": "peak %d bytes, more than the %d of the GPU" % (need, total)})}, f)
    emit({"format": "capacity@1", "products": ["capacity.json"]})


def main():
    job = json.load(open(os.path.join(INPUTS, "job.json")))
    p = job["parameters"]
    rows = rows_of()
    if not rows:
        raise SystemExit("an empty dataset")
    fake = p.get("backend") == "fake"
    if p.get("phase") == "capacity":
        (fake_capacity if fake else qwen_capacity)(job, rows)
    else:
        (fake_train if fake else qwen_train)(job, rows)


if __name__ == "__main__":
    main()
