"""The weight laboratory (SPEC-EDICION-PESOS §4, WE2): what the strong model reads of the junior to propose edits. It only
reads; `try` runs the junior with a candidate set composed on a copy of the modules it touches, restored after.

One query is one job of the worker: {"op": "lab", "lab": {"query": name, "args": {...}, "limits": {...}}, files, circuit,
execution, backend, out}. It answers {"result", "usage": {tokens_in, tokens_out, circuit_steps, wall_ms, peak_bytes},
"files": {name: path}} - files (activations) written to `out`, stored by the server by their hash.

Queries: modules, weights.stats, weights.slice, forward, activations, attention, try (with forward or activations).
The harness checks every argument against the manifest's limits before the query is sent; here the generation is
bounded by them too, and on the GPU the memory is capped for the query.

The fake backend is a toy of the harness's tests: its "model" is the base's safetensors, its forward a digest of its
weights, its activations W·x for a vector x drawn from the case's text. The qwenputer backend has not run on the real
checkpoint yet: the teacher-forced pass over the stream (logits, hooks) is to be checked there first.
"""
import hashlib
import json
import math
import os
import struct
import time
from array import array

import junior_weights as JW


def _layer(name):
    return JW.layer_of(name)


def _editable(name, chip):
    layer = _layer(name)
    return layer is not None and layer >= chip and name.split(".")[-1] in EDITABLE


EDITABLE = {"q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj", "in_proj_qkvz", "in_proj_ba", "out_proj"}


def _text_of(content):
    system = (content or {}).get("system") or ""
    user = (content or {}).get("user")
    if isinstance(user, dict) and isinstance(user.get("parts"), list):
        user = "\n\n".join(p if isinstance(p, str) else json.dumps(p) for p in user["parts"])
    return system, user if isinstance(user, str) else json.dumps(user)


def _percentiles(values, ps):
    s = sorted(values)
    n = len(s)
    return {str(p): s[min(n - 1, int(math.floor(p / 100.0 * (n - 1) + 0.5)))] for p in ps}


def _top_singular_pure(rows, din, k, iterations=40):
    """The k largest singular values of a small matrix (list of rows), by deflated power iteration: the fake backend only."""
    out = []
    M = [r[:] for r in rows]
    for t in range(k):
        v = [math.sin(1.0 + j + 7 * t) for j in range(din)]
        s = 0.0
        for _ in range(iterations):
            u = [sum(r[j] * v[j] for j in range(din)) for r in M]
            v = [sum(M[i][j] * u[i] for i in range(len(M))) for j in range(din)]
            n = math.sqrt(sum(x * x for x in v)) or 1.0
            v = [x / n for x in v]
        u = [sum(r[j] * v[j] for j in range(din)) for r in M]
        s = math.sqrt(sum(x * x for x in u))
        out.append(s)
        if s == 0:
            break
        uh = [x / s for x in u]
        M = [[M[i][j] - s * uh[i] * v[j] for j in range(din)] for i in range(len(M))]
    return out


# --- fake ---------------------------------------------------------------------------------------------------------------

class FakeModel:
    """The base's safetensors as a model: modules by name, their bf16 bits, edits composed into a copy for `try`."""

    def __init__(self, base_dir, chip, adapter_dir=None):
        self.base, self.chip = base_dir, chip
        self.weights = {}
        for f in sorted(os.listdir(base_dir)):
            if f.endswith(".safetensors"):
                for name, (dtype, shape, data) in JW.read_safetensors(open(os.path.join(base_dir, f), "rb").read()).items():
                    if dtype == "BF16" and len(shape) == 2 and name.endswith(".weight"):
                        bits = array("H")
                        bits.frombytes(data)
                        self.weights[name[:-len(".weight")]] = (shape, bits)
        # The package's own set of edits, composed from the start: what the junior diagnosed serves.
        if JW.changes_weights(adapter_dir):
            for name, w in JW.pure_weights(adapter_dir, base_dir, chip).items():
                self.weights[name] = (w["shape"], w["bits"])

    def values(self, name):
        shape, bits = self.weights[name]
        return shape, [JW._bf16_value(b) for b in bits]

    def digest(self):
        h = hashlib.sha256()
        for name in sorted(self.weights):
            h.update(name.encode("utf8"))
            h.update(self.weights[name][1].tobytes())
        return h.hexdigest()

    def edited(self, adapter_dir):
        """A candidate set composed from the START (never on the package's own edits), its digests the set's."""
        copy = FakeModel(self.base, self.chip)
        composed = JW.compose_pure_weights(adapter_dir, self.base, self.chip)
        JW.check_digests(adapter_dir, {n: {"base": w["base"], "edited": w["edited"]} for n, w in composed.items()})
        for name, w in composed.items():
            copy.weights[name] = (w["shape"], w["bits"])
        return copy


def _fake_vector(text, dim):
    out = []
    seed = hashlib.sha256(text.encode("utf8")).digest()
    while len(out) < dim:
        seed = hashlib.sha256(seed).digest()
        out.extend((b - 127.5) / 127.5 for b in seed)
    return out[:dim]


def fake_forward(model, cases, args, limits):
    answers, tin, tout = [], 0, 0
    k = int(args.get("top_logits", 0))
    for c in cases:
        system, user = _text_of(c)
        if "sleep" in user:
            # The harness's tests of the query's time: the toy takes as long as asked.
            time.sleep(float(user.split("sleep", 1)[1].split()[0]))
        text = "answer " + model.digest()[:8] + " to " + user[:24]
        cap = min(int(args.get("max_new_tokens", limits["max_new_tokens"])), limits["max_new_tokens"])
        stop = "answered" if len(text) <= cap else "max_tokens"
        text = text[:cap]
        tin += len(system) + len(user)
        tout += len(text)
        top = [[[ch, 10.0]] + [[chr(97 + (i + j) % 26), 1.0 - j / 10.0] for j in range(1, k)] for i, ch in enumerate(text[: limits["max_positions"]])] if k else []
        answers.append({"text": text, "tokens": len(text), "stop": stop, "top": top})
    return {"cases": answers}, {"tokens_in": tin, "tokens_out": tout, "circuit_steps": 0}


def fake_activations(model, cases, args, out_dir):
    modules = args["modules"]
    result, files, tin = {}, {}, 0
    acts = {}
    for name in modules:
        (dout, din), W = model.values(name)
        rows = []
        for c in cases:
            system, user = _text_of(c)
            x = _fake_vector(system + "\n" + user, din)
            rows.append([sum(W[i * din + j] * x[j] for j in range(din)) for i in range(dout)])
        acts[name] = (dout, rows)
        norms = [math.sqrt(sum(v * v for v in r)) for r in rows]
        result[name] = {"norms": norms, "singular": _top_singular_pure(rows, dout, min(len(rows), int(args.get("directions", 2))))}
    for c in cases:
        system, user = _text_of(c)
        tin += len(system) + len(user)
    files["activations.safetensors"] = _write_acts(acts, out_dir)
    return result, {"tokens_in": tin, "tokens_out": 0, "circuit_steps": 0}, files


def _write_acts(acts, out_dir):
    """Activations as safetensors: one F32 tensor [cases, d_out] per module, names sorted (as the harness writes)."""
    header, blobs, offset = {}, [], 0
    for name in sorted(acts):
        dout, rows = acts[name]
        data = array("f", [v for r in rows for v in r]).tobytes()
        header[name] = {"dtype": "F32", "shape": [len(rows), dout], "data_offsets": [offset, offset + len(data)]}
        blobs.append(data)
        offset += len(data)
    h = json.dumps(header, separators=(",", ":"))
    while (8 + len(h.encode("utf8"))) % 8:
        h += " "
    path = os.path.join(out_dir, "activations.safetensors")
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(h.encode("utf8"))) + h.encode("utf8") + b"".join(blobs))
    return path


def fake_lab(job, q, args, limits, out_dir):
    chip = int((job.get("circuit") or {}).get("chip_layers", 0))
    model = FakeModel(job["files"]["base"], chip, (job.get("files") or {}).get("adapter"))
    files = {}
    if q == "modules":
        return {"modules": [{"name": n, "shape": s, "layer": _layer(n), "editable": _editable(n, chip)} for n, (s, _) in sorted(model.weights.items())]}, {"tokens_in": 0, "tokens_out": 0, "circuit_steps": 0}, files
    if q in ("weights.stats", "weights.slice"):
        name = args["module"]
        if name not in model.weights:
            raise RuntimeError("no module " + name)
        (dout, din), W = model.values(name)
        if q == "weights.stats":
            absw = [abs(x) for x in W]
            rows = [W[i * din:(i + 1) * din] for i in range(dout)]
            return {"module": name, "shape": [dout, din], "norm": math.sqrt(sum(x * x for x in W)), "max_abs": max(absw), "mean_abs": sum(absw) / len(absw),
                    "percentiles_abs": _percentiles(absw, [50, 90, 99, 99.9]), "singular": _top_singular_pure(rows, din, int(args.get("singular", 0)))}, {"tokens_in": 0, "tokens_out": 0, "circuit_steps": 0}, files
        r0, r1 = args["rows"]
        c0, c1 = args["cols"]
        return {"module": name, "rows": [r0, r1], "cols": [c0, c1], "values": [W[i * din + c0:i * din + c1] for i in range(r0, r1)]}, {"tokens_in": 0, "tokens_out": 0, "circuit_steps": 0}, files
    if q == "try":
        model = model.edited(job["lab"]["set"])
        q, args = args["inner"], args["args"]
    cases = job["lab"]["cases"]
    if q == "forward":
        r, u = fake_forward(model, cases, args, limits)
        return r, u, files
    if q == "activations":
        return fake_activations(model, cases, args, out_dir)
    if q == "attention":
        n = max(1, len(_text_of(cases[0])[1]))
        return {"heads": {str(h): {"entropy": math.log(n), "top": []} for h in args["heads"]}, "note": "the fake model has no attention: uniform"}, {"tokens_in": 0, "tokens_out": 0, "circuit_steps": 0}, files
    raise RuntimeError("no query " + q)


# --- qwenputer ----------------------------------------------------------------------------------------------------------

def qwen_lab(job, q, args, limits, out_dir, chat, run_case, bases=None):
    """The queries on the served model. `run_case(content, max_new_tokens)` runs the junior as run_qwenputer does and
    answers (ids_stream, generated tokens, stop, usage). Everything else reads the model through torch."""
    import torch
    chip = int(chat.meta["chip_layers"])
    params = dict(chat.model.named_parameters())
    files = {}
    zero = {"tokens_in": 0, "tokens_out": 0, "circuit_steps": 0}
    if q == "modules":
        mods = sorted(n[:-len(".weight")] for n, p in params.items() if n.endswith(".weight") and p.dim() == 2 and _layer(n) is not None)
        return {"modules": [{"name": n, "shape": list(params[n + ".weight"].shape), "layer": _layer(n), "editable": _editable(n, chip)} for n in mods]}, zero, files
    if q in ("weights.stats", "weights.slice"):
        p = params.get(args["module"] + ".weight")
        if p is None:
            raise RuntimeError("no module " + args["module"])
        W = p.detach().float()
        if q == "weights.slice":
            r0, r1 = args["rows"]
            c0, c1 = args["cols"]
            return {"module": args["module"], "rows": [r0, r1], "cols": [c0, c1], "values": W[r0:r1, c0:c1].cpu().tolist()}, zero, files
        a = W.abs().flatten()
        # Percentiles on a fixed stride of at most 4M entries: torch.quantile refuses larger inputs. Declared as such.
        stride = max(1, a.numel() // (1 << 22))
        sample = a[::stride]
        qs = torch.quantile(sample, torch.tensor([0.5, 0.9, 0.99, 0.999], device=sample.device)).tolist()
        k = int(args.get("singular", 0))
        sv = torch.linalg.svdvals(W)[:k].tolist() if k else []
        return {"module": args["module"], "shape": list(W.shape), "norm": float(W.norm()), "max_abs": float(a.max()), "mean_abs": float(a.mean()),
                "percentiles_abs": {"50": qs[0], "90": qs[1], "99": qs[2], "99.9": qs[3]}, "percentiles_stride": stride, "singular": sv}, zero, files
    saved = {}
    if q == "try":
        q, args = args["inner"], {**args["args"], "_cases": args.get("_cases")}
        bases = bases or {}
        candidate = JW.touched(JW.load_set(job["lab"]["set"], chip)[1])
        # Every module either set touches, kept as it serves now; the package's own edits undone back to the start; the
        # candidate composed from the start (its genome is whole: it never adds to the package's), checked by its digests.
        for name in set(candidate) | set(bases):
            saved[name] = params[name + ".weight"].detach().clone()
        with torch.no_grad():
            for name, w in bases.items():
                params[name + ".weight"].copy_(w)
        try:
            JW.check_digests(job["lab"]["set"], JW.apply_edit_set(chat.model, job["lab"]["set"], chip))
        except Exception:
            with torch.no_grad():
                for name, w in saved.items():
                    params[name + ".weight"].copy_(w)
            raise
    try:
        return _qwen_cases(q, args, limits, out_dir, chat, run_case, params, files)
    finally:
        with torch.no_grad():
            for name, w in saved.items():
                params[name + ".weight"].copy_(w)


def _qwen_cases(q, args, limits, out_dir, chat, run_case, params, files):
    import torch
    cases = args.get("_cases") or []
    usage = {"tokens_in": 0, "tokens_out": 0, "circuit_steps": 0}
    runs = []
    for c in cases:
        stream, gen, stop, u = run_case(c, min(int(args.get("max_new_tokens", limits["max_new_tokens"])), limits["max_new_tokens"]))
        usage["tokens_in"] += u["prompt_tokens"]
        usage["tokens_out"] += u["text_tokens"]
        usage["circuit_steps"] += u["circuit_tokens"]
        runs.append((stream, gen, stop))
    if q == "forward":
        k = int(args.get("top_logits", 0))
        answers = []
        for stream, gen, stop in runs:
            top = []
            if k and gen:
                with torch.no_grad():
                    logits = chat.model(input_ids=torch.tensor([stream], device=chat.model.device)).logits[0].float()
                start = len(stream) - len(gen)
                for pos in range(start, min(len(stream), start + limits["max_positions"])):
                    v, i = torch.topk(logits[pos - 1], k)
                    top.append([[chat.text_of([int(t)]), float(x)] for t, x in zip(i.tolist(), v.tolist())])
            answers.append({"text": chat.text_of(gen), "tokens": len(gen), "stop": stop, "top": top})
        return {"cases": answers}, usage, files
    if q == "activations":
        modules = args["modules"]
        positions = args.get("positions", "generated")
        captured = {m: [] for m in modules}
        hooks = []
        for m in modules:
            mod = chat.model.get_submodule(m)
            hooks.append(mod.register_forward_hook(lambda _mod, _inp, out, m=m: captured[m].append(out[0].detach().float())))
        try:
            for stream, gen, _ in runs:
                with torch.no_grad():
                    chat.model(input_ids=torch.tensor([stream], device=chat.model.device))
        finally:
            for h in hooks:
                h.remove()
        result, acts = {}, {}
        for m in modules:
            rows = []
            for (stream, gen, _), out in zip(runs, captured[m]):
                idx = _positions(positions, len(stream), len(gen), limits["max_positions"])
                rows.append(out[idx].mean(dim=0))
            M = torch.stack(rows)
            acts[m] = (M.shape[1], M.cpu().tolist())
            sv = torch.linalg.svdvals(M)[: int(args.get("directions", 2))].tolist()
            result[m] = {"norms": M.norm(dim=1).tolist(), "singular": sv}
        files["activations.safetensors"] = _write_acts(acts, out_dir)
        return result, usage, files
    if q == "attention":
        layer, heads = int(args["layer"]), [int(h) for h in args["heads"]]
        out = {}
        for stream, gen, _ in runs[:1]:
            with torch.no_grad():
                r = chat.model(input_ids=torch.tensor([stream], device=chat.model.device), output_attentions=True)
            att = (r.attentions or [None] * (layer + 1))[layer] if r.attentions is not None and layer < len(r.attentions) else None
            if att is None:
                return {"unavailable": "layer " + str(layer) + " returns no attention pattern (a DeltaNet layer, or an attention kernel without weights)"}, usage, files
            idx = _positions(args.get("positions", "generated"), len(stream), len(gen), limits["max_positions"])
            for h in heads:
                rows = att[0, h, idx].float()
                ent = (-(rows.clamp_min(1e-12).log() * rows).sum(dim=-1)).tolist()
                tv, ti = torch.topk(rows, min(4, rows.shape[-1]), dim=-1)
                out[str(h)] = {"positions": idx.tolist() if hasattr(idx, "tolist") else list(idx), "entropy": ent, "top": [list(zip(a, b)) for a, b in zip(ti.tolist(), tv.tolist())]}
        return {"heads": out}, usage, files
    raise RuntimeError("no query " + q)


def _positions(spec, total, generated, cap):
    import torch
    if spec == "last":
        idx = [total - 1]
    elif spec == "generated":
        idx = list(range(max(0, total - generated), total)) or [total - 1]
    else:
        idx = [p for p in spec if 0 <= p < total]
    return torch.tensor(idx[:cap])


def lab(job, chat=None, run_case=None, bases=None):
    """One query: its result, what it consumed and the files it wrote."""
    spec = job["lab"]
    q, args, limits = spec["query"], dict(spec.get("args") or {}), spec["limits"]
    out_dir = job["out"]
    started = time.time()
    peak = 0
    if job["backend"] == "fake":
        result, usage, files = fake_lab(job, q, args, limits, out_dir)
    else:
        import torch
        torch.cuda.reset_peak_memory_stats()
        total = torch.cuda.get_device_properties(0).total_memory
        torch.cuda.set_per_process_memory_fraction(min(1.0, limits["max_memory_bytes"] / float(total)))
        try:
            args["_cases"] = spec.get("cases") or []
            result, usage, files = qwen_lab(job, q, args, limits, out_dir, chat, run_case, bases)
        finally:
            torch.cuda.set_per_process_memory_fraction(1.0)
            peak = int(torch.cuda.max_memory_allocated())
    usage = {**usage, "wall_ms": int((time.time() - started) * 1000), "peak_bytes": peak}
    return {"result": result, "usage": usage, "files": files}
