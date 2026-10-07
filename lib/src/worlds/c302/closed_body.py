"""The body and the field of c302nav in closed loop (SPEC-C302-LAZO-CERRADO §8), for the service: the same functions as the
reference in TypeScript (src/worlds/c302closed/body.ts and readout.ts), line for line, checked against it by a parity test
(test/c302closed-parity.test.ts): the same signals give the same course. The standard library only.

Specs are the TypeScript ones, as JSON (camelCase keys): field {source, peak, length, shape, arena, uniform?}, body {speed,
headHz, headAmp, nose, current {min, max, half}, split, rate {gain, r0, max}, mode, threshold, turn {angle, min, max},
steer {gain, maxRate}, arrival, chirality?}, a pose {x, y, heading}.

    python closed_body.py --replay   reads {field, body, start, durationMs, dtMs, initial, signals: [...], seed?, blocked?} on
                                     stdin and drives the body by those signals, step by step (a circuit that replays them);
                                     writes the episode as JSON.
"""
import json
import math
import sys


def mulberry32(seed):
    """The harness's generator (src/worlds/grid/gen.ts), the same numbers."""
    state = [seed & 0xFFFFFFFF]
    m = 0xFFFFFFFF

    def imul(x, y):
        return (x * y) & m

    def rnd():
        state[0] = (state[0] + 0x6D2B79F5) & m
        t = state[0]
        t = imul(t ^ (t >> 15), t | 1)
        t ^= (t + imul(t ^ (t >> 7), t | 61)) & m
        return ((t ^ (t >> 14)) & m) / 4294967296
    return rnd


def concentration(field, p):
    if field.get("uniform"):
        return field["peak"]
    d = math.hypot(p[0] - field["source"][0], p[1] - field["source"][1])
    L = field["length"]
    return field["peak"] * (math.exp(-(d * d) / (2 * L * L)) if field["shape"] == "gauss" else math.exp(-d / L))


def phase_at(body, t_ms):
    return 2 * math.pi * body["headHz"] * t_ms / 1000 - math.pi / 2


def nose_at(body, pose, t_ms):
    head = pose["heading"] + body.get("chirality", 1) * body["headAmp"] * math.sin(phase_at(body, t_ms))
    return (pose["x"] + body["nose"] * math.cos(head), pose["y"] + body["nose"] * math.sin(head))


def sense(body, c, t_ms):
    cur = body["current"]
    total = cur["min"] + (cur["max"] - cur["min"]) * c / (c + cur["half"])
    s = body.get("chirality", 1) * body["split"] * math.sin(phase_at(body, t_ms))
    return total * (1 + s) / 2, total * (1 - s) / 2


def pulse_windows(s, until_ms):
    """The pulses' windows [start, end) up to a time (body.ts pulseWindows): the same seed, the same windows."""
    rnd = mulberry32(s["seed"])

    def pick(xs):
        return xs[int(rnd() * len(xs))]
    out, t = [], pick(s["first"])
    while t < until_ms:
        w = pick(s["width"])
        out.append((t, t + w))
        t += w + pick(s["gap"])
    return out


class Sensor:
    """What comes into the two sides at a step (body.ts Sensor): continuous, or the pulse in course, held from its start."""

    def __init__(self, body, until_ms, held=None, t0=0.0):
        self.body = body
        self.windows = pulse_windows(body["sensing"], until_ms) if body.get("sensing") else None
        self.index = 0
        self.held = held
        self.held_from = t0 if held is not None else None

    def current(self, field, pose, t_ms):
        def smelled():
            return sense(self.body, concentration(field, nose_at(self.body, pose, t_ms)), t_ms)
        if self.windows is None:
            return smelled()
        while self.index < len(self.windows) and self.windows[self.index][1] <= t_ms:
            self.index += 1
        if self.index >= len(self.windows) or t_ms < self.windows[self.index][0]:
            return 0.0, 0.0
        if self.held_from is None or self.held_from < self.windows[self.index][0]:
            self.held, self.held_from = smelled(), t_ms
        return self.held


def turn_rate(body, r):
    rate = body["rate"]
    return min(rate["max"], rate["gain"] * max(0.0, r - rate["r0"]))


def reflect(a, pose):
    x, y, heading = pose["x"], pose["y"], pose["heading"]
    if x > a:
        x, heading = 2 * a - x, math.pi - heading
    elif x < -a:
        x, heading = -2 * a - x, math.pi - heading
    if y > a:
        y, heading = 2 * a - y, -heading
    elif y < -a:
        y, heading = -2 * a - y, -heading
    return {"x": x, "y": y, "heading": heading}


def move(body, field, state, signals, dt_ms, rnd):
    """One step of the body's motion, by the signals at the start of the step."""
    chi = body.get("chirality", 1)
    accumulated, turns = state["accumulated"], state["turns"]
    turn = None
    rate = turn_rate(body, signals["reorientation"])
    dt = dt_ms / 1000
    if body["mode"] == "deterministic":
        accumulated += rate * dt
        if accumulated >= body["threshold"]:
            accumulated -= body["threshold"]
            turn = chi * (1 if turns % 2 == 0 else -1) * body["turn"]["angle"]
            turns += 1
    elif rate > 0 and rnd() < 1 - math.exp(-rate * dt):
        side = 1 if rnd() < 0.5 else -1
        turn = side * (body["turn"]["min"] + (body["turn"]["max"] - body["turn"]["min"]) * rnd())
    steer = body["steer"]
    omega = max(-steer["maxRate"], min(steer["maxRate"], steer["gain"] * signals["steering"]))
    pose = state["pose"]
    heading = pose["heading"] + (turn or 0) + omega * dt
    pose = reflect(field["arena"], {"x": pose["x"] + body["speed"] * dt * math.cos(heading), "y": pose["y"] + body["speed"] * dt * math.sin(heading), "heading": heading})
    return {"pose": pose, "accumulated": accumulated, "turns": turns, "turn": turn}


def run_episode(field, body, circuit, start, duration_ms, dt_ms, rnd=None, blocked=False, t0_ms=0.0, accumulated=0.0, turns=0):
    """One episode in closed loop, in the order of §5 (as runEpisode in body.ts). `circuit` has `initial` (signals) and
    `step(left, right, dt_ms)` (the signals at the end of the step)."""
    rnd = rnd or mulberry32(1)
    pose, signals = dict(start), circuit.initial
    sensor = Sensor(body, t0_ms + duration_ms, None, t0_ms)
    steps = []
    n = int(round(duration_ms / dt_ms))

    def arrived(p):
        return not field.get("uniform") and math.hypot(p["x"] - field["source"][0], p["y"] - field["source"][1]) <= body["arrival"]
    for k in range(n):
        t = t0_ms + k * dt_ms
        if arrived(pose):
            return {"steps": steps, "end": {"t": t, "pose": pose, "reached": True}, "accumulated": accumulated, "turns": turns}
        before, acc_before, turns_before = pose, accumulated, turns
        c = concentration(field, nose_at(body, pose, t))
        left, right = sensor.current(field, pose, t)
        nxt = circuit.step(left, right, dt_ms)
        turn = None
        if not blocked:
            moved = move(body, field, {"pose": pose, "accumulated": accumulated, "turns": turns}, signals, dt_ms, rnd)
            pose, accumulated, turns, turn = moved["pose"], moved["accumulated"], moved["turns"], moved["turn"]
        step = {"t": t, "pose": before, "c": c, "left": left, "right": right, "signals": nxt, "accumulated": acc_before, "turns": turns_before}
        if turn is not None:
            step["turn"] = turn
        steps.append(step)
        signals = nxt
    return {"steps": steps, "end": {"t": t0_ms + n * dt_ms, "pose": pose, "reached": arrived(pose)}, "accumulated": accumulated, "turns": turns}


class Readout:
    """The incremental readout (readout.ts): the double one-pole filter of 200 ms, its state kept between steps."""

    def __init__(self, dt_ms, tau_ms=200.0, unit=1e8):
        self.a = math.exp(-dt_ms / max(tau_ms, dt_ms))
        self.unit = unit
        self.reo = [0.0, 0.0]
        self.steer = [0.0, 0.0]

    def _twice(self, s, x):
        s[0] = self.a * s[0] + (1 - self.a) * x
        s[1] = self.a * s[1] + (1 - self.a) * s[0]
        return float("%.6g" % (s[1] * self.unit))

    def step(self, ca):
        ava, avb = (ca["AVAL"] + ca["AVAR"]) / 2, (ca["AVBL"] + ca["AVBR"]) / 2
        return {"reorientation": self._twice(self.reo, ava - avb), "steering": self._twice(self.steer, ca["RIAL"] - ca["RIAR"])}


class Replay:
    """A circuit that gives recorded signals, one per step, whatever comes in."""

    def __init__(self, initial, signals):
        self.initial, self.signals, self.k = initial, signals, 0

    def step(self, left, right, dt_ms):
        s = self.signals[self.k]
        self.k += 1
        return s


if __name__ == "__main__" and "--replay" in sys.argv:
    req = json.loads(sys.stdin.read())
    ep = run_episode(req["field"], req["body"], Replay(req["initial"], req["signals"]), req["start"], req["durationMs"], req["dtMs"],
                     rnd=mulberry32(req.get("seed", 1)), blocked=req.get("blocked", False))
    sys.stdout.write(json.dumps(ep))
