"""RvChat as the junior's worker uses it: generate() feeds the reference one token at a time through lock.qwen and, at
a store call, the circuit prints its answer into the stream; a question with "slow" takes time per token."""
import json
import os
import time

CALC_TOOL = {"type": "function", "function": {"name": "calc"}}
EOS = 10


class Tok:
    chat_template = "the checkpoint's template"

    def decode(self, ids, skip_special_tokens=False):
        return "".join(chr(i) for i in ids if 32 <= i < 900000)


class Param:
    dtype = "torch.bfloat16"


class Model:
    def parameters(self):
        return iter([Param()])

    def named_parameters(self):
        return iter([])


def load_store_file(path):
    with open(path) as f:
        return json.load(f)


def save_store_file(path, snap):
    with open(path, "w") as f:
        json.dump(snap, f)


class RvChat:
    def __init__(self, path, device=None, fast=True, executor=False):
        self.path = path
        self.meta = json.load(open(os.path.join(path, "chipformer.json")))
        self.tok = Tok()
        self.T = None
        self.store_cfg = self.meta.get("store", {})
        self.eos = {EOS}
        self.v0 = 900000
        self.model = Model()
        self.store_snap = None
        self.last = None

    def prompt_ids(self, messages, tools=()):
        return [ord(c) for c in "\n".join(m["content"] for m in messages)][:200]

    def text_of(self, ids):
        return self.tok.decode(ids)

    def save_store(self):
        return self.last or {}

    def generate(self, ids, machine, max_new=4000, max_chip=60000, check_head=False, verbose=False, lock=None, prefix=None):
        asked = "".join(chr(i) for i in ids)
        slow = "slow" in asked
        out = []
        lock.qwen([ord("A")])
        out.append(ord("A"))
        # A calculation called: the circuit prints its answer inside qwen(), as the real bridge does.
        lock.qwen([7])
        out += [7] + [ord(c) for c in "RESULT"]
        for c in "nswer":
            if slow:
                time.sleep(0.2)
            lock.qwen([ord(c)])
            out.append(ord(c))
        out.append(EOS)
        # The store's snapshot: per persistent head, per value head, its rows that are set.
        self.last = {"files": [{str(i): [1.0] for i in range(len(lock.dev.names()))}]}
        return {"tokens": out, "text_tokens": 6, "chip_tokens": 6, "lock_error": None}
