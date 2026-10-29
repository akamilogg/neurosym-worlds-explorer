"""The junior's trainer (SPEC-METAPOLITICA-APRENDIZAJE §11, MA5): LoRA on Qwen's layers of the combined model, the
compiled circuit frozen. One JSON on stdin, one on stdout; a process of its own on the training GPU.

  {"op": "capacity" | "train", "backend": "fake" | "qwenputer", "base": dir, "circuit": {...}, "recipe": {...},
   "rows": rows.jsonl, "dir": its folder}

capacity  the peak memory of one step on the longest row with the recipe's lengths and batch: {"state": "fits"} or
          {"state": "does_not_fit", "reason"} - never a smaller model or context in its place.
train     the run, going on from dir/checkpoint when there is one; checkpoints as it goes; dir/adapter only when it
          finished: {"state": "finished" | "stopped" | "failed", "steps", "gpu_hours", "checkpoint", "reason"}.

The trainable parameters are checked against the circuit before the first step: any in its first `chip_layers` layers
stops the run. The qwenputer backend has not been run on the real checkpoint yet: MA5 closes with that run.
"""
import json
import math
import os
import sys
import time
import hashlib


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def rows_of(path):
    with open(path, encoding="utf8") as f:
        return [json.loads(l) for l in f if l.strip()]


# --- fake ---------------------------------------------------------------------------------------------------------------

def fake(job):
    rows = rows_of(job["rows"])
    r = job["recipe"]
    if job["op"] == "capacity":
        if r["batch"] > 64:
            return {"state": "does_not_fit", "reason": "peak 30.1 GB with batch %d and length %d: more than the 24 GB of the GPU" % (r["batch"], r["max_length"])}
        return {"state": "fits", "peak_bytes": 1000 * r["batch"] * r["max_length"]}
    total = r["epochs"] * max(1, math.ceil(len(rows) / r["batch"]))
    ck = os.path.join(job["dir"], "checkpoint.json")
    step = json.load(open(ck))["step"] if os.path.exists(ck) else 0
    stop = os.path.join(job["dir"], "STOP_AT")
    while step < total:
        step += 1
        json.dump({"step": step}, open(ck, "w"))
        if os.path.exists(stop) and step >= int(open(stop).read()):
            return {"state": "stopped", "steps": step, "gpu_hours": 0.0, "checkpoint": ck, "reason": "stopped at step %d" % step}
    adapter = os.path.join(job["dir"], "adapter")
    os.makedirs(adapter, exist_ok=True)
    digest = hashlib.sha256(json.dumps([rows, r], sort_keys=True).encode("utf8")).hexdigest()
    json.dump({"fake": True, "r": r["rank"], "lora_alpha": r["alpha"], "layers": r["layers"], "modules": r["modules"], "data": digest,
               "touches_circuit": False}, open(os.path.join(adapter, "adapter_config.json"), "w"), sort_keys=True)
    return {"state": "finished", "steps": step, "gpu_hours": 0.0, "checkpoint": ck}


# --- qwenputer ----------------------------------------------------------------------------------------------------------

def layer_of(name):
    parts = name.split(".")
    for i, p in enumerate(parts):
        if p == "layers" and i + 1 < len(parts) and parts[i + 1].isdigit():
            return int(parts[i + 1])
    return None


def load(job, quantize):
    import torch
    from transformers import AutoTokenizer, Qwen3_5ForCausalLM
    from peft import LoraConfig, get_peft_model
    r, chip = job["recipe"], int(job["circuit"]["chip_layers"])
    tok = AutoTokenizer.from_pretrained(job["base"])
    kw = {"dtype": torch.bfloat16}
    if quantize:
        from transformers import BitsAndBytesConfig
        # Qwen only: the circuit's layers are never quantized (§11).
        skip = ["model.layers.%d" % i for i in range(chip)]
        kw["quantization_config"] = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_compute_dtype=torch.bfloat16, llm_int8_skip_modules=skip)
    model = Qwen3_5ForCausalLM.from_pretrained(job["base"], device_map={"": 0}, **kw)
    pattern = r"model\.layers\.(%s)\..*\.(%s)$" % ("|".join(str(l) for l in r["layers"]), "|".join(r["modules"]))
    model = get_peft_model(model, LoraConfig(r=r["rank"], lora_alpha=r["alpha"], lora_dropout=r["dropout"], target_modules=pattern, bias="none"))
    trainable = [n for n, p in model.named_parameters() if p.requires_grad]
    reached = [n for n in trainable if layer_of(n) is not None and layer_of(n) < chip]
    if reached or not trainable:
        raise RuntimeError("the recipe reaches the circuit: " + ", ".join(reached[:5]) if reached else "nothing would be trained")
    return tok, model


def encode(tok, row, prompt, max_length):
    """The effective sequence: the prompt (context), then each memory call the answer needed - the call in the junior's own
    protocol, as its driver writes it (StoreSession.call_tokens: a decision, in the loss) and its result (what it read:
    context, out of the loss) - then the answer (in the loss)."""
    from chipformer.rv import store as ST
    from chipformer.rv.chat import CALC_TOOL
    system = "\n\n".join(p for p in (ST.MEM_SYSTEM, prompt, row["system"]) if p)
    msgs = [{"role": "system", "content": system}, {"role": "user", "content": "\n\n".join(row["user"])}]
    ids = tok.apply_chat_template(msgs, tools=[CALC_TOOL, *ST.TOOLS], add_generation_prompt=True, enable_thinking=False, tokenize=True)
    ids = ids["input_ids"] if isinstance(ids, dict) else list(ids)
    seq, labels = [], []
    for c in row.get("calls", []):
        # The store's tools take the package's token ids, None for what a call has not (list has no name, get no text).
        ids_of = lambda s: None if s is None else [int(t) for t in tok(s, add_special_tokens=False)["input_ids"]]
        call = [int(t) for t in ST.StoreSession.call_tokens(c["op"], ids_of(c.get("name")), ids_of(c.get("text")))]
        seen = tok("<tool_response>\n" + c["result"] + "\n</tool_response>\n", add_special_tokens=False)["input_ids"]
        seq += call + seen
        labels += call + [-100] * len(seen)
    ans = tok(row["answer"], add_special_tokens=False)["input_ids"] + [tok.eos_token_id]
    seq += ans
    labels += ans
    keep = max_length - len(seq)
    if keep <= 0:
        return None
    ids = ids[-keep:]
    return ids + seq, [-100] * len(ids) + labels


def qwenputer(job):
    import torch
    r = job["recipe"]
    rows = rows_of(job["rows"])
    torch.manual_seed(r["seed"])
    tok, model = load(job, r["method"] == "qlora")
    prompt = job.get("prompt", "")
    data = [x for x in (encode(tok, row, prompt, r["max_length"]) for row in rows) if x is not None]
    if not data:
        return {"state": "failed", "reason": "no row fits in max_length"}
    if job["op"] == "capacity":
        torch.cuda.reset_peak_memory_stats()
        ids, labels = max(data, key=lambda d: len(d[0]))
        try:
            loss = model(input_ids=torch.tensor([ids]).cuda(), labels=torch.tensor([labels]).cuda()).loss
            loss.backward()
        except torch.cuda.OutOfMemoryError as e:
            return {"state": "does_not_fit", "reason": "out of memory on a row of %d tokens: %s" % (len(ids), e)}
        peak, total = torch.cuda.max_memory_allocated(), torch.cuda.get_device_properties(0).total_memory
        if peak > 0.95 * total:
            return {"state": "does_not_fit", "reason": "peak %d of %d bytes" % (peak, total)}
        return {"state": "fits", "peak_bytes": int(peak), "total_bytes": int(total)}
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=r["learning_rate"])
    ck = os.path.join(job["dir"], "checkpoint")
    step = 0
    if os.path.exists(os.path.join(ck, "state.json")):
        from peft import set_peft_model_state_dict
        from safetensors.torch import load_file
        set_peft_model_state_dict(model, load_file(os.path.join(ck, "adapter_model.safetensors")))
        opt.load_state_dict(torch.load(os.path.join(ck, "optimizer.pt")))
        step = json.load(open(os.path.join(ck, "state.json")))["step"]
    order = list(range(len(data)))
    per_epoch = max(1, math.ceil(len(order) / r["batch"]))
    total = r["epochs"] * per_epoch
    started = time.time()
    model.train()
    while step < total:
        g = torch.Generator().manual_seed(r["seed"] + step // per_epoch)
        perm = torch.randperm(len(order), generator=g).tolist()
        b = step % per_epoch
        opt.zero_grad()
        for i in perm[b * r["batch"]:(b + 1) * r["batch"]]:
            ids, labels = data[i]
            loss = model(input_ids=torch.tensor([ids]).cuda(), labels=torch.tensor([labels]).cuda()).loss / r["batch"]
            loss.backward()
        opt.step()
        step += 1
        if step % 10 == 0 or step == total:
            os.makedirs(ck, exist_ok=True)
            model.save_pretrained(ck)
            torch.save(opt.state_dict(), os.path.join(ck, "optimizer.pt"))
            json.dump({"step": step}, open(os.path.join(ck, "state.json"), "w"))
        if (time.time() - started) / 3600 > r["max_gpu_hours"]:
            return {"state": "stopped", "steps": step, "gpu_hours": (time.time() - started) / 3600, "checkpoint": ck, "reason": "max_gpu_hours"}
    model.save_pretrained(os.path.join(job["dir"], "adapter"))
    return {"state": "finished", "steps": step, "gpu_hours": (time.time() - started) / 3600, "checkpoint": ck}


def main():
    job = json.loads(sys.stdin.read())
    try:
        out(fake(job) if job["backend"] == "fake" else qwenputer(job))
    except Exception as e:
        out({"state": "failed", "reason": type(e).__name__ + ": " + str(e)})


if __name__ == "__main__":
    main()
