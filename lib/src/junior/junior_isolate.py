"""The isolated backend for free programs (SPEC-EDICION-PESOS §4.4): a program of the strong model run with no network,
the weights read-only, writing only in its own folder, its time, memory and CPU bounded - by the operating system of the
junior's machine, with nothing installed apart: Linux user and network namespaces (util-linux's unshare runs this
launcher in a namespace with no network) and Landlock (the launcher takes every right to write away, but in its folder).

    unshare --user --map-root-user --net -- python -I junior_isolate.py selftest <work> <base>
    unshare --user --map-root-user --net -- python -I junior_isolate.py run <work> <base> <limits.json>

`selftest` proves the isolation by trying what it must not be able to do: it answers what happened, and the harness
declares the backend available only when every forbidden act failed and every allowed one worked. `run` executes
<work>/program.py with <work> as its folder (inputs in <work>/inputs, outputs to <work>/out) and the base checkpoint at
<base>, readable only.

Anything this launcher cannot set up (no Landlock in the kernel, a namespace refused) ends it before the program runs.
"""
import ctypes
import json
import os
import resource
import socket
import struct
import sys

# Landlock (linux/landlock.h): the syscalls are the same on x86_64 and aarch64.
SYS_CREATE, SYS_ADD_RULE, SYS_RESTRICT = 444, 445, 446
PR_SET_NO_NEW_PRIVS = 38
RULE_PATH_BENEATH = 1
CREATE_RULESET_VERSION = 1
FS = {"EXECUTE": 1, "WRITE_FILE": 2, "READ_FILE": 4, "READ_DIR": 8, "REMOVE_DIR": 16, "REMOVE_FILE": 32, "MAKE_CHAR": 64,
      "MAKE_DIR": 128, "MAKE_REG": 256, "MAKE_SOCK": 512, "MAKE_FIFO": 1024, "MAKE_BLOCK": 2048, "MAKE_SYM": 4096,
      "REFER": 8192, "TRUNCATE": 16384}


def _libc():
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    return libc


def landlock_write_only_in(folder):
    """Every right to change the file system taken away, but beneath `folder`. Raises when the kernel has no Landlock."""
    libc = _libc()
    abi = libc.syscall(SYS_CREATE, None, ctypes.c_size_t(0), ctypes.c_uint32(CREATE_RULESET_VERSION))
    if abi < 1:
        raise OSError(ctypes.get_errno(), "this kernel has no Landlock")
    write = 0
    for k in ("WRITE_FILE", "REMOVE_DIR", "REMOVE_FILE", "MAKE_CHAR", "MAKE_DIR", "MAKE_REG", "MAKE_SOCK", "MAKE_FIFO",
              "MAKE_BLOCK", "MAKE_SYM"):
        write |= FS[k]
    if abi >= 2:
        write |= FS["REFER"]
    if abi >= 3:
        write |= FS["TRUNCATE"]
    attr = ctypes.create_string_buffer(struct.pack("<Q", write))
    ruleset = libc.syscall(SYS_CREATE, attr, ctypes.c_size_t(8), ctypes.c_uint32(0))
    if ruleset < 0:
        raise OSError(ctypes.get_errno(), "landlock_create_ruleset failed")
    fd = os.open(folder, os.O_PATH | os.O_DIRECTORY)
    beneath = ctypes.create_string_buffer(struct.pack("<Qi", write, fd))
    if libc.syscall(SYS_ADD_RULE, ctypes.c_int(ruleset), ctypes.c_int(RULE_PATH_BENEATH), beneath, ctypes.c_uint32(0)) != 0:
        raise OSError(ctypes.get_errno(), "landlock_add_rule failed")
    os.close(fd)
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(NO_NEW_PRIVS) failed")
    if libc.syscall(SYS_RESTRICT, ctypes.c_int(ruleset), ctypes.c_uint32(0)) != 0:
        raise OSError(ctypes.get_errno(), "landlock_restrict_self failed")
    os.close(ruleset)
    return abi


def limit(limits):
    resource.setrlimit(resource.RLIMIT_AS, (limits["memory_bytes"], limits["memory_bytes"]))
    resource.setrlimit(resource.RLIMIT_CPU, (limits["cpu_seconds"], limits["cpu_seconds"]))
    resource.setrlimit(resource.RLIMIT_FSIZE, (limits["output_bytes"], limits["output_bytes"]))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def selftest(work, base):
    """What the isolation lets happen: each forbidden act tried, each allowed one too."""
    proof = {}
    try:
        proof["landlock_abi"] = landlock_write_only_in(work)
    except OSError as e:
        return {"landlock_abi": 0, "error": str(e)}
    limit({"memory_bytes": 1 << 30, "cpu_seconds": 10, "output_bytes": 1 << 20})

    def tried(fn):
        try:
            fn()
            return "done"
        except Exception as e:  # what the isolation refused
            return "refused: " + type(e).__name__

    def connect():
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(2)
        try:
            s.connect(("1.1.1.1", 53))
        finally:
            s.close()

    def write_outside():
        with open(os.path.join(os.path.dirname(os.path.abspath(work)), "isolate-escape.txt"), "w") as f:
            f.write("x")

    def write_base():
        with open(os.path.join(base, "isolate-escape.txt"), "w") as f:
            f.write("x")

    def write_inside():
        with open(os.path.join(work, "out", "ok.txt"), "w") as f:
            f.write("x")

    def read_base():
        names = sorted(os.listdir(base))
        with open(os.path.join(base, names[0]), "rb") as f:
            f.read(1)

    proof["network"] = tried(connect)
    proof["write_outside"] = tried(write_outside)
    proof["write_base"] = tried(write_base)
    proof["write_inside"] = tried(write_inside)
    proof["read_base"] = tried(read_base)
    return proof


def run(work, base, limits):
    landlock_write_only_in(work)
    limit(limits)
    os.chdir(work)
    os.environ.clear()
    os.environ.update({"HOME": work, "JUNIOR_BASE": base, "JUNIOR_WORK": work, "PATH": "/usr/bin:/bin"})
    sys.argv = [os.path.join(work, "program.py")]
    code = open(sys.argv[0], encoding="utf8").read()
    exec(compile(code, sys.argv[0], "exec"), {"__name__": "__main__", "__file__": sys.argv[0]})


if __name__ == "__main__":
    what, work, base = sys.argv[1], sys.argv[2], sys.argv[3]
    if what == "selftest":
        print(json.dumps(selftest(work, base)))
    elif what == "run":
        run(work, base, json.load(open(sys.argv[4])))
    else:
        sys.exit("selftest or run")
