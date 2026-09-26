# Cat & Mouse · a neuro-symbolic harness for learning unknown worlds

Can a language model work out the rules of a game it has never seen, from nothing but a picture of the
board, its own experiments and how its games end? And if it can, is what it learns something a human can read?

This repository is an experiment built to answer both questions. An LLM (**System 2**) proposes hypotheses,
writes code that measures what it perceives, runs experiments against the environment and turns what it
learns into an evaluation formula. A second model (**System 1**, the semantic judge *Jev*) judges positions
using **only** the observations System 2 chose to give it. A search plays the games. Everything System 2
learns stays in a form you can read: its code, its rules in plain language, its beliefs and its notebook.

> Status: research prototype. The results below come from 19 runs; most comparisons are one run per
> condition. Read them as strong signals, not established results.

## The idea

The value of a position is a formula anyone can read:

```
V(s) = Σ_i w_i · r_i(O(s))
             │      └─ O(s): observations, measured by CODE that System 2 writes over what it perceives
             └──────── r_i:  rules in plain language, answered by the judge (System 1)
       w_i: weights summing to 1, composed in code
```

- **Code observes, the judge judges.** An observation is deterministic code: a number with a range, or,
  without a range, a text the judge reads as written. A rule is a question in words that cites observations.
- **The judge sees nothing else.** Not the picture, not the position, not the rules of the game: only the
  words of the rules, the observations and whose turn it is. What System 2 does not measure, the judge does
  not see.
- **System 2 never plays and never computes values.** It proposes the formula; a minimax search plays with it.

## The unknown-world experiment

To separate "remembers the strategy" from "discovers the strategy", games are **generated from a seed**
(board size and shape, how each side moves, how each side wins, turn limit), so no model can know them from
pretraining. System 2 perceives them only as an ASCII picture, rotated or mirrored per seed, with neutral
symbols. It gets no rules, no meaningful names and no list of legal moves.

It learns only from its own sources:

| Instrument | What it gives System 2 |
|---|---|
| `view` / `inspect` | the pictures of its games; what its own search saw on a turn, rule by rule and observation by observation |
| `try` | attempt a change from a position; the environment only says allowed (with the new picture) or refused, never why |
| `measure` | run one of its observations over any positions |
| `play` | play a laboratory game from any position with any of its formulas |
| `table` / probes | how an observation or a question separates positions by how the game ended (score -1..1, concordance, a permutation test) |
| notebook | beliefs with a mandatory stance each round, notes pointing to positions, its own methods |

The environment offers primitive actions only: no precooked analysis, no hints, and no environment-specific
examples in the prompt. The solver, a heuristic that knows the rules, the hidden spec and a rule-recovery
grade exist **only for the operator**, in the run journal, and never reach System 2 or the judge.

## What we found

Evidence level: **solid** means repeated across runs or a direct comparison; **signal** means one or two runs
per condition. Run-to-run variance is large.

1. **An LLM can discover the rules of a world it does not know, from its own experiments** *(solid)*. One run
   recovered the entire game: how both sides move and every way a game ends, including the draw at the
   turn limit, through a rotated picture and with no hints. It got there with controlled `try` pairs that differ
   in one thing, repeated games from the same start, and tables of final positions.
2. **Winning is not understanding** *(solid)*. With no instruments at all, System 2 still won 16/16 on one
   seed while believing it was playing Connect Four: the search won the game for it. The discriminating
   measure is **rule recovery**, not win rate, and seeds must be checked on starting positions never played.
3. **A judge that sees only System 2's observations works as an attention mechanism directed by System 2**
   *(strong signal)*. Removing the picture from the judge turned it from a net cost into a net gain against a
   code-only ablation (0–3 → 6–2 rounds) and cut judge calls from ~9000 to ~650. Positions that measure the
   same become one question, so the cache hits: understanding compresses the game.
4. **Instruments buy interpretability and, as a by-product, cost** *(signal)*. At equal wins: with
   instruments, ~17 judge calls per trial and real rules recovered; without them, ~785 calls per trial and no
   rule at all.
5. **One architecture, two modes** *(observed)*. *Interpretable*: precise observations, hypotheses, rules.
   *Delegated*: System 2 hands the whole scene to the judge as text and the decision rests with System 1 (the
   self-driving-car mode). When blinded, System 2 chose delegation on its own: "if I can't see, let the judge
   see."
6. **Errors in the instrument become false beliefs** *(solid)*. Draws labelled as losses, verdict labels and
   duplicated games each led System 2 to drop correct ideas. The fix was always the same: facts, not verdicts.
7. **Generic method guidance changes behaviour without leaking the environment** *(signal)*, and **the model
   matters more than the prompt** for reasoning bottlenecks such as over-caution *(signal)*.

Failure modes we saw in System 2: pretraining priors ("fox", "runner", an imagined Connect Four),
over-caution in the face of complete evidence, anchoring on a noisy scoreboard, understanding the game without
carrying it into the formula, and leaving instruments unused.

**The thesis under test:** if System 2 generalizes to scenarios it has never seen, LLMs have latent
generalization ability, and what they lack are instruments like these. Still missing to support it: the
instrument ladder on a discriminating seed, repetitions per condition, rule-recovery scores across runs, and
a clean comparison of the interpretable and delegated modes on the same formula.

The full account, in Spanish, is in [INFORME.md](INFORME.md) (section *Mundo desconocido: hallazgos de los runs 1–19*).

## Repository

| Path | What it is |
|---|---|
| [`lib/`](lib/README.md) | `neurosym`, the portable TypeScript core (no runtime dependencies): World, Observer, Formula, Judge, Evaluator, Search, and the learner |
| `lib/src/worlds/grid/` | the generated games, their ASCII sense, starting-position variants, and operator-only tools |
| `lib/src/learn/` | the explorer (System 2's protocol), notebook, experiments and probes, ablations, the learning loop |
| `lib/scripts/run-grid.ts` | runs the unknown-world experiment and writes a JSON journal to `runs/` (journals are not published) |
| `lib/scripts/calibrate-grid.ts` | finds seeds that leave room to learn (forced win, learnable, not won by a flat judge, not a known game) |
| `fox-hounds-harness.html` | the original browser harness on Fox & Hounds (a known game), with the library bundled in |
| `INFORME.md`, `SPEC-*.md` | report and specifications (Spanish) |

## Running it

Requires Node ≥ 22.6.

```bash
cd lib && npm install && npm test
```

Find seeds worth learning (no network needed):

```bash
node --experimental-strip-types scripts/calibrate-grid.ts 1 40 2 2,4
```

Run the experiment. Endpoints and keys come from the environment only: `LLM_URL` (any OpenAI-compatible
`/chat/completions`), `LLM_MODEL`, `LLM_KEY`, and `JEV_KEY` (optionally `JEV_URL`) for the judge. The easiest way
is a launcher: copy `lib/run-grid.example.ps1` (Windows) or `lib/run-grid.example.sh` to `run-grid.ps1` /
`run-grid.sh` in the same folder, fill in your keys (those two names are git-ignored), and pass any option through:

```bash
./run-grid.sh --seed 22
```

or set the variables yourself and call the script directly:

```bash
node --experimental-strip-types scripts/run-grid.ts --seed 22
```

Useful options: `--tools none` (or a subset such as `view,inspect,probes`) for the baseline without
instruments, `--flat` for a judge that knows nothing, `--variants N` for generalization starts. The header of
`run-grid.ts` documents them all.

## License

[MIT](LICENSE)
