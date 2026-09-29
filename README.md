# Neuro-symbolic harness for learning unknown worlds

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

The prompt is ONE text for every world (`lib/src/learn/prompt.ts`): a researcher persona, a research method and a general
account of the instruments. It says nothing about the nature of the world; each world adds only its interface (what its
model produces and the parameters of each instrument) and the shape of what is perceived. The instruments have common names:

| Instrument | What it gives System 2 |
|---|---|
| `view` / `inspect` | what was recorded in its episodes; what its own model computed at a point, rule by rule and observation by observation |
| `act` | intervene in the environment (earlier `try` / `launch`); it only says whether it accepted and what followed, never why |
| `replay` | run an episode again in the environment from any point, with any of its models (earlier `play`) |
| `simulate` | run a model forward alone, without the environment |
| `measure` | run one of its observations over any points |
| `table` | the rows: the value of its code at every point of a kind, with the score its episode ended with - any statistic over them is System 2's own |
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

## Next: a physical world

The same principle, applied to discovering a **law of motion**. Bodies move in a plane under a law drawn per
seed and, on purpose, not the one a model knows: a pull that falls as r^-2.37 instead of r^-2, a hidden mass, a
term in the velocity, a screened or anisotropic pull. System 2 perceives only noisy tables of positions, in a
rotated, mirrored and rescaled frame with neutral symbols, and launches bodies of its own to experiment. Its task
is to answer, at any row, the next row of the body it launched. The model is the same artifact in every world:

```
V(s)   = Σ_i w_i · r_i(O(s))                          the judge's answers to rules over code observations, weighted
answer = output(p, { observations: O(s), rules: r_i, V })     optional code; without it the answer is V(s)
```

Nothing imposes a shape on the answer (no directions, magnitudes or ranges): System 2 builds it, and may combine its
rules with any logic it writes - the rule network of `SPEC-RULENET.md`, in its own code.

Every round the law is tested on launches it has never seen, some starting beyond the region it observes, where
a law that only fits what it has seen breaks down. Ablations compare the law against the same observations
without the judge, a constant, and a judge that reads the whole table (the delegated mode). The operator grades
the recovered law against the hidden one. System 2 is never given an error to optimize: for every test point the
environment returns its verdict (a vector in [-1, 1] per axis, 0 where the prediction agrees) and whether the law was
accepted, and System 2 works out the rest. First runs with a real model recovered the exponent (r^-2.65 against a hidden
2.66) and showed why the environment, not only the learner, decides what "finding the law" means. The design and the runs
are in [SPEC-MUNDO-FISICO.md](SPEC-MUNDO-FISICO.md) (Spanish).

## Repository

| Path | What it is |
|---|---|
| [`lib/`](lib/README.md) | `neurosym`, the portable TypeScript core (no runtime dependencies): World, Observer, Formula, Judge, Evaluator, Search, and the learner |
| `lib/src/worlds/grid/` | the generated games, their ASCII sense, starting-position variants, and operator-only tools |
| `lib/src/learn/` | the explorer (System 2's protocol), notebook, experiments and probes, ablations, the learning loop |
| `lib/src/worlds/grid/` (`lab.ts`) | the unknown-world experiment (the grid): a laboratory with a loop of its own (its model is a formula a search plays with), run by the common runner; it writes a JSON journal to `runs/` (journals are not published) |
| `lib/scripts/calibrate-grid.ts` | finds seeds that leave room to learn (forced win, learnable, not won by a flat judge, not a known game) |
| `lib/src/worlds/orbit/` | the physical world: laws by level, the table sense, prediction points and test launches, operator-only tools |
| `lib/src/core/output.ts`, `lib/src/core/predict.ts`, `lib/src/learn/law-*.ts` | a model's output code, the predictor, the law explorer (System 2's protocol there), the law ablations |
| `lib/src/worlds/orbit/` (`lab.ts`), `lib/scripts/calibrate-orbit.ts` | the physical world, declared as a laboratory and run by the common runner; finds laws that leave room to discover (Newton misses clearly above the noise) |
| `lib/src/learn/objective.ts`, `protocol.ts`, `operator.ts`, `law-session.ts` | the operator's objective as a contract, the researcher's protocol (the same for every world), the operator's common measures, a session with System 2 for a world whose answer is a model ([SPEC-OBJETIVO.md](SPEC-OBJETIVO.md)) |
| `lib/src/worlds/*/objective.ts` | each world's objective: the form of its answer, its cases, its verdict and its criterion |
| `lib/src/learn/lab.ts`, `lib/src/runtime/lab-runner.ts`, `lib/scripts/run-lab.ts` | a world as one declaration (`Lab`: world, senses, episodes, optional actions, objective, the operator's truth and baselines) and the one runner every such world uses: `run-lab.ts --lab cells` (the laboratory API is exported as `neurosym/lab`) |
| `lib/src/worlds/cells/` (`lab.ts`) | a third world, connected with only its world, senses, actions and objective: rows of symbols under a hidden local rule (level 3: of second order); the answer is the next row |
| `lib/src/worlds/messages/` (`lab.ts`) | a world whose percept is text - the test of the Judge: short texts marked 0 or 1 by a hidden rule over what they say; the family keeps the rule and changes the wording |
| `lib/src/worlds/tank/`, `lib/scripts/tank-service.ts` | a laboratory whose environment is OUTSIDE the harness: a service in a process of its own that keeps state and acts; each request is done once (an idempotency key) and its answer logged, so a run stopped and resumed never makes it act twice |
| `lib/src/learn/finding.ts`, `lib/scripts/finding.ts` | the finding of a run (`finding@1`), derived from its journal for whoever uses the result: the question, the model, what it claims, where it held and where it failed, the known limits, the cost and how to reproduce it. Two views: the operator's (`.finding.json`, every measure of the operator for audit - and, for a world someone wrote, its truth and the grade against it) and the researcher's (`.finding.researcher.json`, what another agent is given: only what the world answered). The lab runner writes both next to the journal, and the script derives them from any journal |
| `lib/src/view/`, `lib/scripts/journal-view.ts`, `journal-viewer.html` | the journal viewer: an animated visual synthesis of a finished run, built from its journal (open `journal-viewer.html` and drop a journal on it) |
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
instruments, `--flat` for a judge that knows nothing, `--variants N` for new starts in each check, `--family N` and
`--validations N` for the researcher's protocol (the model is checked on its laboratory board every round, validated on
boards of other sizes and pieces when System 2 asks, and accepted by boards nobody has seen), and `--quick` to stop the
first time System 2 judges its model good. `--help` lists them all.

The physical world works the same way, with `lib/run-orbit.example.ps1` / `.sh` as launchers:

```bash
node --experimental-strip-types scripts/calibrate-orbit.ts 1 20 1
./run-orbit.sh --seed 3 --level 1
```

Its options include `--level 1..4`, `--sampling grid|free` (test points that repeat, or new ones every round),
`--resolution X` (rounded perception), `--tools`, `--delegated` and `--quick` (stop the first time System 2 judges its
law good, without validating it, to see whether a change makes the exploration promising); `--help` lists them all. It is
declared as a laboratory (`lib/src/worlds/orbit/lab.ts`) like cells and messages, so it can be stopped and resumed and
writes its finding. `--regression` answers each laboratory's previous check again with the new law (the paired regression,
on by default in the grid).

A third world, `cells@1`, uses the same prompt and protocol with nothing of its own but its world, senses, instruments
and objective. It is declared as a laboratory (`lib/src/worlds/cells/lab.ts`) and run by the common runner, as is
`messages@1`; `--help` lists each world's options (`lib/run-cells.example.ps1` / `.sh`, or `scripts/run-lab.ts --lab cells`):

```bash
./run-cells.sh --seed 1 --level 1     # --level 2: a count over five cells; --level 3: the row before matters too
```

`messages@1` is the test of the Judge (`lib/run-messages.example.ps1` / `.sh`). Everything perceived is text: code
written against the laboratory's wording breaks on the family's, and a reader of meaning does not. The flat-judge
ablation in the journal says what the Judge's rules added:

```bash
./run-messages.sh --seed 1
```

A laboratory run can be stopped and resumed. Ctrl+C stops it before the next question to System 2 (a second Ctrl+C at
once), as do `--max-minutes N` and `--max-tokens N`. Every answer from System 2 and the Judge is logged next to the journal
as it arrives (`<journal>.replay.jsonl`: answers only, never a request or a key). `--resume <journal>` runs the same
experiment again in a run of its own (`<journal>.resumed-<time>.json`), serving those answers: the run is back where it
stopped, exactly, and goes on live; the journal it resumes is left as it was. If the resumed run asks something the first
did not (the code or the configuration changed), it stops there (`diverged`) instead of going on as if it were the same run.
The budgets stop the run between questions to System 2: they are not a hard ceiling on what a question in flight costs:

```bash
./run-cells.sh --seed 1 --level 3 --max-tokens 200000
./run-cells.sh --resume runs/cells-s1L3-<time>.json
```

An environment can live outside the harness. `tank@1` is a service in a process of its own that keeps state and acts. The
laboratory learns only what the service answers. Every request carries an idempotency key, and the answer is logged like
System 2's: a resumed run replays what the service answered instead of acting again, and a request the service had
already acted on when the run stopped is answered again without acting:

```bash
node --experimental-strip-types scripts/tank-service.ts --port 18300
node --experimental-strip-types scripts/run-lab.ts --lab tank --service http://127.0.0.1:18300
```

Runs are also controlled from the command line, the same for every laboratory and researcher: start one in a process of
its own, list them, follow one, stop it, resume it, read its finding (SPEC-INVESTIGADOR-ASISTIDO):

```bash
node --experimental-strip-types scripts/lab.ts start cells --seed 1 --level 3
node --experimental-strip-types scripts/lab.ts list
node --experimental-strip-types scripts/lab.ts watch last
node --experimental-strip-types scripts/lab.ts stop last
node --experimental-strip-types scripts/lab.ts finding last --view researcher
```

The same, as a local page (`http://127.0.0.1:18400`): the runs, one followed live (its events, its current model, its
checks, its beliefs, its cost and findings), stop, resume and start - and, for the assisted researcher, collaborate:

```bash
node --experimental-strip-types scripts/lab-console.ts
```

Another program (an agent that coordinates investigations, say) runs a laboratory as a call, with no environment variables,
console, signals or `process.exit`:

```ts
import { runLaboratory } from 'neurosym/lab';
import { cellsLab } from 'neurosym/cells';

const controller = new AbortController();          // abort: stop before the next question to System 2
const result = await runLaboratory(cellsLab, {
  args: ['--seed', '1', '--level', '3'], root: '.', signal: controller.signal,
  llm: { url: 'https://.../chat/completions', model: '...', key: '...' }, judge: { key: '...' }
});
result.stoppedBy;  // accepted, budget, cancelled, diverged, ...
result.researcher; // finding@1 for another agent: the model, what it claims, where it held and failed, its limits, its cost
result.finding;    // the same with every measure of the operator (for audit)
```

Every journal ends with `operator_summary`: rounds, the first round the model held, each validation, the acceptance, the
cost (Judge calls and evaluations it was not asked, LLM calls and tokens) in all and up to the acceptance, what the
Judge's rules added in the ablations, and - where the run declares baselines that know nothing (cells, orbit) - the checks
one of them passed too (`check_is_trivial`): an acceptance there would tell nothing.

### Seeing a run

A journal can be turned into a single self-contained page, a visual synthesis of the exploration (built afterwards from
the data, not live):

```bash
cd lib && npm run view -- runs/<journal>.json     # writes runs/<journal>.html next to it
```

or open [`journal-viewer.html`](journal-viewer.html) in a browser and drop any journal on it (`npm run view -- --blank`
rebuilds it). Nothing leaves the browser. For the animations the journal keeps, for the operator only, what the
environment showed in each exploration episode and, per place of every check, a trace of a few cases (the model's answer
and what happened); System 2 is shown neither. The page shows:

- **Síntesis**: the relevant moments in order, as cards. Each moment has a relevance: it rises when the final model cites
  its evidence, when a check changed the verdict or first held, and when a validation or acceptance happened. A slider
  sets the minimum relevance, and "solo el camino al modelo final" keeps only the path to the final model: the evidence
  its surviving beliefs cite, the proposals that introduced them, the checks they refer to, and the validations. Click a
  card for its detail, animated: what the environment showed (rows growing step by step, messages arriving with their
  marks, bodies moving along their trails, a game's pictures in turn) and, in a check or a validation, what the model
  tried case by case (its answer against what came, the cells it got wrong outlined, a running tally). **Presentar**
  plays the selected moments one after another, each with its animations - for showing a run to someone.
- **Comprobaciones**: the check score per round, with a table view.
- **Creencias**: each belief's lineage (new, revised, confirmed, dropped) across rounds.
- **Línea temporal**: every event by kind and round, sized by relevance, with the path outlined.
- **Modelo final**, and, apart, what only the operator sees (the truth, the grades, `operator_summary`).

## License

[MIT](LICENSE)
