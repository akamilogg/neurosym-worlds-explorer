"""A set of weight edits (weight-edit-set@1) composed by the worker (SPEC-EDICION-PESOS §3.2, WE1).

compose@1: for each module touched, its delta W accumulated in fp32 in the order of the genome - each low-rank edit rank by
rank as an outer product (one rounding per product, one per sum: never a library's matrix product), each sparse edit
entry by entry - then applied once, W' = bf16(fp32(W_start) + delta). The same arithmetic as the harness's reference
(weights.ts): the digests the worker reports of what it served must be the ones the set records.

Two ways, the same bits:
  compose_pure   pure Python, for the fake backend and the harness's tests (no numpy, no torch).
  apply_edit_set torch, on the served model, in place.

Only the set's own files are read: its manifest, each edit's manifest and tensors.
"""
import hashlib
import json
import math
import os
import struct
from array import array

SET_MANIFEST = "set.json"
_WIDTH = {"F32": 4, "BF16": 2, "I64": 8}


def is_edit_set(adapter_dir):
    return bool(adapter_dir) and os.path.exists(os.path.join(adapter_dir, SET_MANIFEST))


def read_safetensors(data):
    """{name: (dtype, shape, bytes)} from safetensors bytes."""
    n = struct.unpack("<Q", data[:8])[0]
    header = json.loads(data[8:8 + n].decode("utf8"))
    header.pop("__metadata__", None)
    out = {}
    for name, e in header.items():
        a, b = e["data_offsets"]
        out[name] = (e["dtype"], list(e["shape"]), data[8 + n + a:8 + n + b])
    return out


def _read(path):
    with open(path, "rb") as f:
        return f.read()


def load_set(adapter_dir, chip_layers):
    """The set's manifest and its genome's edits, each checked against its hash; refused if one reaches the circuit."""
    s = json.loads(_read(os.path.join(adapter_dir, SET_MANIFEST)).decode("utf8"))
    if s.get("format") != "weight-edit-set@1" or s.get("rule") != "compose@1":
        raise RuntimeError("the adapter is not a weight-edit-set@1 with rule compose@1")
    edits = []
    for eid in s["genome"]:
        folder = os.path.join(adapter_dir, "edits", eid)
        raw = _read(os.path.join(folder, "edit.json"))
        if hashlib.sha256(raw).hexdigest() != eid:
            raise RuntimeError("edit " + eid + " does not match its hash")
        edit = json.loads(raw.decode("utf8"))
        mods = []
        for m in edit["modules"]:
            data = _read(os.path.join(folder, m["file"]))
            if hashlib.sha256(data).hexdigest() != m["sha256"]:
                raise RuntimeError("edit " + eid + ": " + m["file"] + " does not match its hash")
            mods.append((m, read_safetensors(data)))
        edits.append(mods)
    for mods in edits:
        for m, _ in mods:
            if layer_of(m["module"]) is None or layer_of(m["module"]) < chip_layers:
                raise RuntimeError("the edits reach the circuit: " + m["module"])
    return s, edits


def layer_of(module):
    parts = module.split(".")
    if "layers" not in parts:
        return None
    try:
        return int(parts[parts.index("layers") + 1])
    except (ValueError, IndexError):
        return None


def touched(edits):
    return sorted({m["module"] for mods in edits for m, _ in mods})


def digest(module, shape, bf16_bytes):
    h = hashlib.sha256()
    h.update((module + "\n" + "x".join(str(d) for d in shape) + "\n").encode("utf8"))
    h.update(bf16_bytes)
    return h.hexdigest()


# --- pure Python ------------------------------------------------------------------------------------------------------

def _f32(x):
    return struct.unpack("<f", struct.pack("<f", x))[0]


def _bf16_bits(x):
    u = struct.unpack("<I", struct.pack("<f", x))[0]
    if (u & 0x7F800000) == 0x7F800000 and (u & 0x7FFFFF):
        return 0x7FC0
    return ((u + 0x7FFF + ((u >> 16) & 1)) >> 16) & 0xFFFF


def _bf16_value(bits):
    return struct.unpack("<f", struct.pack("<I", (bits & 0xFFFF) << 16))[0]


def _base_tensor(base_dir, name):
    index = os.path.join(base_dir, "model.safetensors.index.json")
    if os.path.exists(index):
        files = [json.load(open(index))["weight_map"][name]]
    else:
        files = sorted(f for f in os.listdir(base_dir) if f.endswith(".safetensors"))
    for f in files:
        t = read_safetensors(_read(os.path.join(base_dir, f)))
        if name in t:
            dtype, shape, data = t[name]
            if dtype != "BF16" or len(shape) != 2:
                raise RuntimeError(name + " is " + dtype + ": edits compose on bf16 matrices")
            bits = array("H")
            bits.frombytes(data)
            return shape, bits
    raise RuntimeError("the base has no tensor " + name)


def compose_pure(adapter_dir, base_dir, chip_layers):
    """{module: {"base", "edited"}} digests of the set composed on the base's tensors, in pure Python."""
    return {name: {"base": w["base"], "edited": w["edited"]} for name, w in compose_pure_weights(adapter_dir, base_dir, chip_layers).items()}


def compose_pure_weights(adapter_dir, base_dir, chip_layers):
    """{module: {"shape", "bits" (array of bf16 bits after), "base", "edited"}}: the set composed in pure Python."""
    _, edits = load_set(adapter_dir, chip_layers)
    out = {}
    for name in touched(edits):
        shape, W = _base_tensor(base_dir, name + ".weight")
        dout, din = shape
        delta = array("f", bytes(4 * dout * din))
        for mods in edits:
            for m, t in mods:
                if m["module"] != name:
                    continue
                if m["encoding"] == "lowrank":
                    B, A = array("f"), array("f")
                    B.frombytes(t["B"][2])
                    A.frombytes(t["A"][2])
                    r = t["B"][1][1]
                    for k in range(r):
                        for a in range(dout):
                            b = B[a * r + k]
                            if b == 0:
                                continue
                            for j in range(din):
                                # array("f") stores each sum rounded to fp32; the product is rounded first.
                                delta[a * din + j] = delta[a * din + j] + _f32(b * A[k * din + j])
                else:
                    idx, v = array("q"), array("f")
                    idx.frombytes(t["indices"][2])
                    v.frombytes(t["values"][2])
                    for k in range(len(idx)):
                        delta[idx[k]] = delta[idx[k]] + v[k]
        after = array("H", (_bf16_bits(_f32(_bf16_value(W[x]) + delta[x])) for x in range(dout * din)))
        if not all(math.isfinite(_bf16_value(b)) for b in after) or not all(math.isfinite(d) for d in delta):
            raise RuntimeError(name + ": the composition is not finite")
        out[name] = {"shape": shape, "bits": after, "base": digest(name, shape, W.tobytes()), "edited": digest(name, shape, after.tobytes())}
    return out


# --- torch ------------------------------------------------------------------------------------------------------------

def check_digests(adapter_dir, composed):
    """The digests composed against the set's own summaries: the start and the result of every module, or an error."""
    summaries = json.loads(_read(os.path.join(adapter_dir, SET_MANIFEST)).decode("utf8"))["summaries"]
    for name, s in summaries.items():
        c = composed.get(name)
        if c is None or c["base"] != s["base_digest"] or c["edited"] != s["digest"]:
            raise RuntimeError("the set composed here is not the set's weights at " + name)
    if set(composed) - set(summaries):
        raise RuntimeError("composed modules the set does not summarize")


def apply_edit_set(model, adapter_dir, chip_layers, bases=None):
    """The set composed into the served model's weights in place; {module: {"base", "edited"}} digests of what it serves.
    `bases`, when given, keeps a copy of each module's start before it is changed: what a `try` composes from."""
    import torch
    _, edits = load_set(adapter_dir, chip_layers)
    params = dict(model.named_parameters())

    def bits(W):
        return W.detach().contiguous().view(torch.int16).cpu().numpy().tobytes()

    def tensor(entry, dtype, device):
        _, shape, data = entry
        return torch.frombuffer(bytearray(data), dtype=dtype).reshape(shape).to(device)

    out = {}
    for name in touched(edits):
        W = params.get(name + ".weight")
        if W is None:
            raise RuntimeError("the served model has no " + name + ".weight")
        if W.dtype != torch.bfloat16:
            raise RuntimeError(name + " is served in " + str(W.dtype) + ": edits compose on bf16")
        shape = list(W.shape)
        before = digest(name, shape, bits(W))
        if bases is not None:
            bases[name] = W.detach().clone()
        delta = torch.zeros(shape, dtype=torch.float32, device=W.device)
        for mods in edits:
            for m, t in mods:
                if m["module"] != name:
                    continue
                if m["encoding"] == "lowrank":
                    B = tensor(t["B"], torch.float32, W.device)
                    A = tensor(t["A"], torch.float32, W.device)
                    for k in range(B.shape[1]):
                        # The product as its own elementwise kernel (rounded), then the sum: no fused reduction.
                        delta.add_(B[:, k:k + 1] * A[k:k + 1, :])
                else:
                    idx = tensor(t["indices"], torch.int64, W.device)
                    v = tensor(t["values"], torch.float32, W.device)
                    flat = delta.view(-1)
                    flat[idx] = flat[idx] + v
        with torch.no_grad():
            new = (W.float() + delta).to(torch.bfloat16)
            if not bool(torch.isfinite(delta).all()) or not bool(torch.isfinite(new).all()):
                raise RuntimeError(name + ": the composition is not finite")
            W.copy_(new)
        out[name] = {"base": before, "edited": digest(name, shape, bits(W))}
    return out
