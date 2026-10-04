# Neuro-symbolic harness for scientific discovery in unknown worlds

Can a language model investigate a world it has never seen, the way a scientist would: form hypotheses, design
experiments that tell them apart, read what comes back, revise, and end with a model of the world that holds where it
was never tried? And if it can, is what it learned something a person can read and check?

This repository is a laboratory built to answer those questions. An LLM (**System 2**, the researcher) experiments with an
environment through primitive instruments, keeps a notebook, and proposes a model of the world. A second model (**System
1**, the semantic judge *Jev*) answers the questions in plain language that the model asks, seeing **only** what the
researcher chose to measure. **The world decides**: every model is checked on cases it never saw, validated on other
worlds that share its rule, and accepted only by worlds nobody has seen. Everything the researcher learns stays readable:
its code, its rules in words, its beliefs with their evidence, and its notebook.

Around that core the project has grown into a research platform: six worlds, two researchers (one that learns only from
the world, one that can be helped), agents that supervise and coordinate investigations, teams that research in parallel,
a metric of the scientific method itself beside the outcome, and consoles to follow it all.

> Status: research prototype. Results come from dozens of runs with several models (Qwen, GPT-6 Luna and Sol), most
> conditions with few repetitions. Read them as strong signals, not established results. Design documents and run reports
> are in Spanish (`SPEC-*.md`, `INFORME.md`).

## Contents

- [The idea](#the-idea): the model as a readable formula; code observes, the judge judges
- [Worlds](#worlds): six laboratories, from generated games to a Blender physics world
- [The researcher's protocol](#the-researchers-protocol): instruments, notebook, check, validation and blind confirmation
- [Two researchers](#two-researchers): the unknown-world researcher, frozen, and the assisted one
- [The orchestra](#the-orchestra): agent operators, the senior, batches, the project planner, teams in parallel
- [Measuring](#measuring): the outcome, and an audit of the method beside it
- [What we found](#what-we-found)
- [Repository](#repository) · [Running it](#running-it) · [Documents](#documents)

## The idea

The researcher's model is a formula anyone can read:

```
V(s)   = Σ_i w_i · r_i(O(s))                                the judge's answers to rules over code observations, weighted
answer = output(p, { observations: O(s), rules: r_i, V })    optional code; without it the answer is V(s)
            │      └─ O(s): observations, measured by CODE the researcher writes over what it perceives
            └──────── r_i:  rules in plain language, answered by the judge (System 1)
```

- **Code observes, the judge judges.** An observation is deterministic code: a number with a range, or a text the judge
  reads as written. A rule is a question in words that cites observations.
- **The judge sees nothing else**: not the picture, the position or the world, only the words of the rules and the
  observations. What the researcher does not measure, the judge does not see. It works as an attention mechanism the
  researcher directs.
- **The researcher never plays and never computes values.** In a game, a search plays with its formula; in a world of
  laws, its `output` code answers what is asked (the next row, the next position).

## Worlds

Worlds are **generated or hidden**, so that no model can know them from pretraining, and are perceived only through
neutral symbols, rotated and mirrored per seed. Each is one declaration (`Lab`: world, senses, episodes, actions,
objective, the operator's truth) run by one common runner.

| World | What is hidden | What the researcher perceives | Its answer |
|---|---|---|---|
| `unknown-world@1` (the grid) | a two-player game generated from a seed: board, moves, how each side wins, turn limit | an ASCII picture of the board | an evaluation formula a search plays with |
| `orbit@1` | a law of motion drawn per seed, on purpose not Newton's (r^-2.37, a hidden mass, a screened pull…) | noisy tables of positions in a rotated, rescaled frame | the next row of a body it launched |
| `cells@1` | a local rule over a ring of symbols (level 3: second order; level 4: two layers) | rows of symbols | the next row |
| `messages@1` | a rule over what short texts say (the test of the Judge) | texts marked 0 or 1 | the mark of a new text |
| `tank@1` | a stateful environment **outside** the harness, as a service | what the service answers | its next state |
| `particles3d@1` | particles under force fields with hidden masses and charges, pairwise pulls, chaos at level 6, **simulated by Blender** | tables of 3D positions (never told it is Blender) | the next positions |

An environment can live outside the harness: requests carry idempotency keys, and every answer is logged, so a run
stopped and resumed never acts twice.

## The researcher's protocol

The prompt is **one text for every world** (`lib/src/learn/prompt.ts`): a researcher persona, a research method and a
general account of the instruments. It says nothing about the nature of any world; each world adds only its interface.

| Instrument | What it gives |
|---|---|
| `view` / `inspect` | what was recorded in its episodes; what its own model computed at a point, rule by rule |
| `act` | intervene in the environment; it only says whether it was accepted and what followed, never why |
| `replay` | run an episode again from any point, with any of its models (backtracking included) |
| `simulate` | run a model forward alone, without the environment |
| `measure` / `table` | run its own code over any points; the rows of a table, any statistic over them is its own |
| notebook | beliefs with a mandatory stance each round (new, keep, revise, confirm, drop) and their evidence; notes; its own methods |

The environment offers primitive actions only: no precooked analysis, no hints, no examples from the environment, and
**no metric to optimize**: for every case it returns a verdict as a fact, and the researcher measures the rest.

Every round the model is **checked** on cases it never saw (with the previous check run again, to catch regressions). When
the researcher asks, it is **validated** on other worlds of the same family, where the rule is the same and the
parameters are not; it is **accepted** only by two sets of **blind** worlds nobody has seen. A run that used up its rounds
can be continued, its history replayed exactly; any run can be stopped and resumed, and a resumed run that asks something
different stops instead of pretending to be the same run.

## Two researchers

- **The unknown-world researcher** learns only from what the world answers. Its prompt is frozen (a test hashes it), and
  it refuses all help, logging that it did. It is the reference for measuring the capability itself.
- **The assisted researcher** shares the protocol and may also be helped, always as a declared condition:
  - a **task** in words, **messages** and a **focus** on a facet of the world, from a person or an agent;
  - **sources**: documents it reads by itself, where the operator allows, with `list`, `open` and `find` (and the Judge
    picking lines when it asks); it cites them, and the finding says which claims rest on the world, on sources, or both;
  - a **selective memory** over its own record: its notebook travels abridged by a fixed rule, and it recalls the rest
    itself; it may also **consolidate** its round's conversation into its own summary;
  - **experience**: the records of earlier runs (only what their researchers saw), in two isolated modes: `transfer`
    (other worlds only, refusing even runs that indirectly knew this one) or `meta` (a researcher of researchers, which
    may read runs of this very world, marked as prior knowledge); and two scopes, everything or **only methods**, to tell
    apart transferring a way of investigating from transferring knowledge of a domain.

Every request to a model is grown as an append-only conversation within a round, so a provider's cache can reuse it.

## The orchestra

Agents that use exactly the operator's API, never see more than the researcher they help, and leave a journal of every
decision (`SPEC-ORQUESTADOR.md`):

- **Agent operator**: follows an assisted run and helps it out of a dead end, as a person would.
- **Senior**: a more capable model that reads a stuck junior's record when it shows signs of being stuck (holding nowhere,
  repeated requests, only looking, regressions), proposes a hypothesis with its evidence, how to test it and how to bring
  it into the model, and follows up after the junior's next experiment. It guides; it does not do the junior's work.
- **Batches**: runs compared by condition, from what their researchers found.
- **Project planner**: pursues a question in a loop (hypotheses with predictions, a batch, a synthesis) until a computable
  criterion holds or the budget is spent, with the operator approving its plans; it can open **branches** from a run stuck
  in a local minimum.
- **Research in parallel** (`SPEC-INVESTIGACION-PARALELA.md`), a separate condition that measures the collective system,
  never one researcher: a researcher may explore other boards of the family besides its laboratory, and a **team** runs
  several researchers on one family with a board they publish to (results, dead ends, methods, with the records behind
  them) and read by windows, with exam boards none of them may explore.

## Measuring

Two metrics, read side by side and never combined into one mark:

- **The outcome**: whether the model holds in the checks, validates on worlds that share the rule, and is accepted by
  blind worlds. Knowing the hidden truth is not required; where a world has one, the operator also grades how much of it
  the researcher recovered (rule recovery).
- **The method** (`SPEC-AUDITORIA-METODO.md`): whether the researcher chains its instruments as a scientific method:
  hypothesis → an experiment that tells it apart → the result read right → a belief updated in proportion. From a finished
  journal, `lab audit` reconstructs each experiment with what was held before it, what it showed point by point and what
  was written after; **code observes** (refused experiments and who cited them, citations to things never shown, orphan
  steps, paired comparisons, replications, replays set against the record, how beliefs moved) and **the Judge answers
  closed questions** (purpose, discrimination, reading, scope, response to refutation, use of controls). An extractor
  structures each text's claims, and facts are checked against what was shown at the points they cite, read by form in
  every world. The Judge is **calibrated against a person**: a blind sample, a page to label it, and the agreement per
  question (Cohen's kappa) decide which questions can be trusted.

Every run ends with a **finding** in two views: the operator's (every measure, for audit) and the researcher's (only what
the world answered), which is what another agent is given.

## What we found

Evidence level: **solid** means repeated across runs or a direct comparison; **signal** means one or two runs per
condition. Run-to-run variance is large.

1. **An LLM can discover the rules of a world it does not know, from its own experiments** *(solid)*. One run recovered an
   entire generated game, every way a game ends included, through a rotated picture and with no hints, with controlled
   pairs of acts that differ in one thing, repeated games from one start, and tables of final positions. In the physical
   world, first runs recovered a hidden exponent (r^-2.65 against r^-2.66).
2. **Winning is not understanding** *(solid)*. With no instruments, a researcher won 16/16 while believing it was playing
   Connect Four: the search won for it. The discriminating measures are rule recovery and checks on starts never played;
   a model that wins 8/8 can still fail to generalize, as later replays of the same model showed.
3. **A judge that sees only the researcher's observations works as an attention mechanism** *(strong signal)*. Removing
   the picture from the judge turned it from a net cost into a net gain against a code-only ablation and cut its calls
   from ~9000 to ~650: positions that measure the same become one question.
4. **Errors in the instrument become false beliefs** *(solid)*. Draws labelled as losses, verdict labels and duplicated
   games each led the researcher to drop correct ideas. The fix was always the same: facts, not verdicts.
5. **A senior paired with a cheaper junior is a good pair** *(signal)*. GPT-6 Luna with a GPT-6 Sol senior held 8/8 in
   round 8 for about $0.33, against $1.29 for Sol alone (7/8). The senior's best contributions were new hypotheses with an
   experiment to test them; its worst, a fact it misread from a picture, which the junior then refuted by looking.
6. **Researchers backtrack on their own** *(signal)*. After a refinement broke a model that held, the researcher replayed
   its earlier model from the new failing starts as a baseline and concluded that neither generalized, instead of
   assuming the old one was right.
7. **Generic method guidance changes behaviour without leaking the environment** *(signal)*, and the model matters more
   than the prompt for bottlenecks such as over-caution or long contexts (the selective memory was built for the latter).

Failure modes seen: pretraining priors (an imagined Connect Four), over-caution with complete evidence, anchoring on a
noisy score, understanding a rule without carrying it into the model, leaving instruments unused, and stating as a fact
what was a misreading.

**The thesis under test:** if a researcher generalizes to worlds it has never seen, LLMs have latent ability to do
science, and what they lack are instruments and a method like these. The full account is in [INFORME.md](INFORME.md).

## Repository

| Path | What it is |
|---|---|
| [`lib/`](lib/README.md) | `neurosym`, the TypeScript core with no runtime dependencies |
| `lib/src/core/` | World, Observer, Formula, Judge (Jev), Evaluator, Search, the predictor and a model's output code |
| `lib/src/learn/` | the common prompt, the explorer and law sessions (the researcher's protocol), notebook, objective and protocol (check, validation, blind confirmation), findings |
| `lib/src/learn/assisted/` | the assisted researcher: operator channel, sources, selective memory, experience, the record reader, the team board |
| `lib/src/worlds/` | the laboratories: `grid`, `orbit`, `cells`, `messages`, `tank`, `particles3d` (and `foxhounds`, the original known game) |
| `lib/src/orchestra/` | agent operators and the senior, batches, the project planner, teams |
| `lib/src/audit/` | the method audit: links and code observations, the Judge's questions, claim extraction and fact checks, calibration |
| `lib/src/runtime/` | the common runner, control API, CLI, replay log, regrading, the classic console |
| `lib/src/console/` | the research observatory: now, trajectory by rounds, evidence, queries and an analyst of the record |
| `lib/src/view/`, `journal-viewer.html` | the journal viewer: an animated synthesis of a finished run |
| `lib/scripts/` | runners, calibrators that find seeds worth learning, services (tank, Blender), the console, the bundle |
| `INFORME.md`, `EVAL-UNKNOWN-WORLD.md`, `SPEC-*.md` | the report and the specifications (Spanish) |

## Running it

Requires Node ≥ 22.6.

```bash
cd lib && npm install && npm test
```

Endpoints and keys come from the environment only: `LLM_URL` (any OpenAI-compatible `/chat/completions`), `LLM_MODEL`,
`LLM_KEY`, and `JEV_KEY` (optionally `JEV_URL`, `JEV_MODEL`) for the judge; agents, the planner, the grader and the audit's
extractor take `AGENT_LLM_*`, `PLANNER_LLM_*`, `GRADER_LLM_*` and `AUDIT_LLM_*` (default `LLM_*`). The easiest way is a
launcher: copy `lib/lab.example.ps1` (or a `run-<world>.example.ps1` / `.sh`) to the same name without `.example`, fill
in your keys (those names are git-ignored), and pass any option through. `--flat` runs any world with a judge that knows
nothing, without a key.

### Runs

The same command line for every world and researcher (`lab` is `node --experimental-strip-types scripts/lab.ts`, or the
`lab.ps1` launcher):

```bash
lab start grid --seed 22 --researcher assisted --memory selective
lab list
lab watch last
lab send last "look at the cells two positions apart"     # the assisted researcher only
lab stop last
lab resume last                                           # or --resume <journal> --attempts N to give it more rounds
lab finding last --view researcher
```

Useful options: `--tools none` (or a subset) for a baseline without instruments; `--family N`, `--validations N`,
`--confirm-places N` for the protocol; `--max-minutes N`, `--max-tokens N` as budgets; `--task`, `--focus`,
`--sources-allow`, `--experience <journals> [--experience-mode meta] [--experience-scope methods]` for the assisted
researcher. `--help` lists each world's own options (levels, sampling, conditions).

Some worlds need a service of their own:

```bash
node --experimental-strip-types scripts/tank-service.ts --port 18300
node --experimental-strip-types scripts/particles3d-service.ts --port 18500      # Blender
```

### Agents, batches, projects, teams

```bash
lab agent last --role senior                       # a senior follows the run (start it with --agents senior=message)
lab batch examples/batch.example.json
lab project start examples/project.example.json
lab project approve <id>
lab team examples/team.example.json
```

### Grading and auditing

```bash
lab grade <run>                                    # grade the recovered rule again, with GRADER_LLM_*
lab audit <run> --flat                             # the method: what code observes, no cost
lab audit <run> --extract                          # plus the Judge's answers and the checked claims
lab audit sample <run> --n 30 --with r6.s2         # a blind sample to label, with a page to label it
lab audit agreement labels.json                    # how far the Judge agrees with you, per question
```

### Consoles and viewers

```bash
node --experimental-strip-types scripts/lab-console.ts
```

Opens `http://127.0.0.1:18400`, the classic console (start, follow, stop, resume, message runs, projects) and
`/research`, the observatory: what each researcher is doing now, the **trajectory by rounds** (checks, regressions,
models and returns to earlier ones, steps by kind, beliefs moved, messages, replays), the evidence, text queries over a
fixed cut of the record, and an analyst that investigates the record with a budget of its own.

A finished journal becomes a self-contained animated page with `npm run view -- runs/<journal>.json`, or by dropping it on
[`journal-viewer.html`](journal-viewer.html).

A laboratory can also be run as a call by another program:

```ts
import { runLaboratory } from 'neurosym/lab';
import { cellsLab } from 'neurosym/cells';

const result = await runLaboratory(cellsLab, {
  args: ['--seed', '1', '--level', '3'], root: '.',
  llm: { url: 'https://.../chat/completions', model: '...', key: '...' }, judge: { key: '...' }
});
result.stoppedBy;   // accepted, budget, cancelled, diverged, ...
result.researcher;  // finding@1 for another agent
result.finding;     // the same with every measure of the operator
```

## Documents

| Document | About |
|---|---|
| [INFORME.md](INFORME.md) | the report: the engine, the runs and what they showed |
| [EVAL-UNKNOWN-WORLD.md](EVAL-UNKNOWN-WORLD.md) | how to evaluate the unknown-world researcher, step by step |
| [SPEC-OBJETIVO.md](SPEC-OBJETIVO.md) | the objective as a contract: cases, verdicts, check, validation, blind confirmation |
| [SPEC-MODELO-DEL-MUNDO.md](SPEC-MODELO-DEL-MUNDO.md) | the world model: discovering rules and validating them as a researcher |
| [SPEC-MUNDO-FISICO.md](SPEC-MUNDO-FISICO.md), [SPEC-MUNDO-3D.md](SPEC-MUNDO-3D.md) | the physical world, and particles in 3D simulated by Blender |
| [SPEC-RULENET.md](SPEC-RULENET.md) | a small network of semantic rules, mostly covered by `output` |
| [SPEC-INVESTIGADOR-ASISTIDO.md](SPEC-INVESTIGADOR-ASISTIDO.md) | the two researchers; sources, selective memory, experience |
| [SPEC-ORQUESTADOR.md](SPEC-ORQUESTADOR.md) | agent operators, the senior, batches, the planner, branches |
| [SPEC-INVESTIGACION-PARALELA.md](SPEC-INVESTIGACION-PARALELA.md) | research in parallel: exploration boards and teams |
| [SPEC-AUDITORIA-METODO.md](SPEC-AUDITORIA-METODO.md) | the method audit and its calibration |
| [SPEC-CONSOLA-INVESTIGACION.md](SPEC-CONSOLA-INVESTIGACION.md) | the research observatory |
| [SPEC-APRENDIZAJE-DIFFS-Y-ACCIONES.md](SPEC-APRENDIZAJE-DIFFS-Y-ACCIONES.md) | earlier work: learning from diffs, judging by consensus, explicit actions |

## License

[MIT](LICENSE)
