"""The store's contract as chipformer.rv.store has it (rv-store branch): names and texts are lists of Qwen token ids or
None; a key is (length, name) - length the name's tokens capped at NMAX + 1, name its first NMAX tokens padded with 0;
Device.names() gives the live keys in creation order, Device.text(key) a live file's tokens; StoreSession.call(op, name,
text) runs one call through qwen() and printed() gives the bodies printed, as text."""

NMAX = 6
TCC = 7  # the token closing a tool call
NL = 10  # the newline the call format puts after each value
CMAX = 104
MEM_SYSTEM = "You have a memory with put, append, get, list and delete."
TOOLS = ({"type": "function", "function": {"name": "put"}}, {"type": "function", "function": {"name": "get"}})


class Config:
    def __init__(self, **kw):
        self.kw = kw


def key_of(name):
    toks = [int(t) for t in name[:NMAX]]
    return (max(min(len(name), NMAX + 1), 0), tuple(toks + [0] * (NMAX - len(toks))))


class Entry:
    def __init__(self, key, text):
        self.key, self.text, self.alive = key, list(text), True


class Device:
    def __init__(self):
        self.dir, self.order = {}, []

    def names(self):
        return [self.dir[k].key for k in self.order if self.dir[k].alive]

    def text(self, key):
        e = self.dir.get(key)
        return list(e.text) if e is not None and e.alive else None


class StoreSession:
    def __init__(self, text, machine, cfg=None, dev=None):
        self.T, self.m, self.cfg = text, machine, cfg
        self.dev = dev if dev is not None else Device()
        self.toks, self.answers, self.bodies = [], [], []
        self._text = []

    def history(self, qids):
        self.toks += [int(q) for q in qids]
        self._text += [int(q) for q in qids]

    def qwen(self, qids, max_records=10 ** 6, run=True):
        for q in qids:
            self.toks.append(int(q))
            self._text.append(int(q))
            if int(q) == TCC and run:
                # A calculation's call closed: the circuit runs and prints its answer into the stream.
                self.echo("RESULT")

    def qwen_text(self):
        return list(self._text)

    def echo(self, s):
        """The circuit prints, as the bridge's run() does: its own records in the stream, and each character it printed
        echoed as a Qwen token - in the stream and in the text Qwen sees."""
        self.toks += [900000 + ord(c) for c in s] + [ord(c) for c in s]
        self._text += [ord(c) for c in s]

    @staticmethod
    def call_tokens(op, name=None, text=None):
        t = [1, 2] + [ord(c) for c in op]
        if name is not None:
            t += [3] + [int(x) for x in name]
        if text is not None:
            t += [4] + [int(x) for x in text]
        return t + [5]

    def call(self, op, name=None, text=None):
        self.qwen(self.call_tokens(op, name, text))
        # As the real scan captures them: each value with the newline the call format puts after it, before its closing tag.
        name = None if name is None else list(name) + [NL]
        text = None if text is None else list(text) + [NL]
        k = key_of(name) if name is not None else None
        e = self.dev.dir.get(k) if k else None
        if op in ("put", "append"):
            if e is None or not e.alive:
                self.dev.dir[k] = Entry(k, text[:CMAX])
                if k not in self.dev.order:
                    self.dev.order.append(k)
            elif op == "put":
                e.text = list(text[:CMAX])
            else:
                e.text += list(text[:CMAX])
            body, ans = "ok", (op, e is not None, False)
        elif op == "get":
            body = "".join(chr(t) for t in e.text) if e is not None and e.alive else "not found"
            ans = (op, e is not None and e.alive, False)
        elif op == "delete":
            found = e is not None and e.alive
            if found:
                e.alive = False
            body, ans = ("ok" if found else "not found"), (op, found, False)
        else:
            names = self.dev.names()
            body = "\n".join("".join(chr(t) for t in n[1][:n[0]] if t) for n in names) or "empty"
            ans = ("list",)
        self.answers.append(ans)
        self.bodies.append((len(self.toks), body))
        self.echo(body)
        return self.answers[-1]

    def printed(self, start=0):
        return [b for at, b in self.bodies if at >= start]
