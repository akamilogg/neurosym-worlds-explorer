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

Around that core the project has grown into a research platform, in four layers:

1. **Investigating.** Worlds of hidden laws and generated games, worlds where the product is an **artifact** to build
   and optimize, and **living worlds** that change while they are investigated. Two researchers: one that learns only
   from the world, and one that can be helped.
2. **Organizing research.** Agents that follow and unblock investigations, a **senior** that coaches a junior, batches,
   a project planner, teams in parallel, and **delegation**: an investigation opening branches of its own, among them an
   **evolutionary search** over programs.
3. **Measuring it.** The outcome, an audit of the scientific method beside it, the **climb** of every metric a world
   offers, and research packages and validation records that let a person check a result without trusting the run.
4. **Learning to research and to learn.** A **research meta-policy** (procedures that advise the researcher, evaluated by
   whole investigations) and a **learning meta-policy**: a small model with a memory of its own (**Qwenputer**), improved
   by a strong model in a world whose artifact is the junior itself, until it can take over its own learning.

> **Status: research prototype.** The results below come from dozens of runs with several models (Qwen, GPT-6 Luna and
> Sol), most conditions with few repetitions: read them as strong signals, not established results. The newest layers -
> living worlds, the research meta-policy's pilot and the learning meta-policy - are implemented and tested with
> stand-in models (about 770 tests), and are waiting for their first real runs. Design documents and run reports are in
> Spanish (`SPEC-*.md`, `INFORME.md`).

## Contents

- [The idea](#the-idea): the model as a readable formula; code observes, the judge judges
- [Worlds](#worlds): laws, games, circuits, artifacts, living worlds, and the junior's own world
- [The researcher's protocol](#the-researchers-protocol): instruments, its own instruments and tests, check, validation and blind confirmation
- [Two researchers](#two-researchers): the unknown-world researcher, frozen, and the assisted one
- [The orchestra](#the-orchestra): agent operators, the senior, batches, the planner, teams, delegation and evolutionary search
- [Living worlds](#living-worlds): actors, events and reactive research
- [Learning to research better](#learning-to-research-better): the research meta-policy
- [Learning to learn: a junior that improves itself](#learning-to-learn-a-junior-that-improves-itself): the learning meta-policy
- [Measuring](#measuring): the outcome, the method, the climb, and evidence a person can check
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
  laws, its `output` code answers what is asked (the next row, the next position, the metric of a run).

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
| `c302nav`, `c302closed` | a model of the nervous system of *C. elegans* (OpenWorm's c302, simulated with NEURON), in open loop and in **closed loop** with a body moving in a field of odour; ported from EurekaBench's `navigation-goals` as a world of this harness | its stimuli, its acts on the network and the calcium of its cells | the signals of the circuit, and its navigation |
| `artifacts@1` | how a program behaves: a data script (`dedup`), or deciding 3SUM from a cubic base (`threesum`, `threesum-subquadratic`) | its versions' files, and its runs on workloads of a family | the metric of a run; and, apart, a **better artifact**, judged against the reference on fresh workloads |
| `plates` (living) | a world that changes while it is investigated: actors, programmed events, signals | windows of a shared session | its model of the world, revised as the world moves |
| `junior-competence@1` | what makes a small junior model a better researcher | the junior's versions and their evaluations on fixed cases | a better junior, promoted case by case against the reference |

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
| its own instruments | analysis code it writes once and calls by name, in a sandbox, over views of its own series |
| its own tests | predictions it registers before the experiment runs, against a rival model, judged by the world |
| notebook | beliefs with a mandatory stance each round (new, keep, revise, confirm, drop) and their evidence; notes; its own methods and documents |

The environment offers primitive actions only: no precooked analysis, no hints, no examples from the environment, and
**no metric to optimize**: for every case it returns a verdict as a fact, and the researcher measures the rest. Everything
that reaches System 2 between its answers - an operator's message, a senior's directive, a notice of the world, the advice
of a policy - arrives through **one message channel**, marked with who said it. When the researcher suspects that the
instrument, not the world, is wrong, it can **report an anomaly**, and the operator rules on it.

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
    may read runs of this very world, marked as prior knowledge); and two scopes, everything or **only methods**;
  - the **advice of a research policy** (below), always as advice, never as an order.

Every request to a model is grown as an append-only conversation within a round, so a provider's cache can reuse it.

## The orchestra

Agents that use exactly the operator's API, never see more than the researcher they help, and leave a journal of every
decision (`SPEC-ORQUESTADOR.md`):

- **Agent operator**: follows an assisted run and helps it out of a dead end, as a person would.
- **Senior**: a more capable model that reads a stuck junior's record when it shows signs of being stuck (holding nowhere,
  repeated requests, only looking, regressions), proposes a hypothesis with its evidence, how to test it and how to bring
  it into the model, and follows up after the junior's next experiment. It guides; it does not do the junior's work, and
  the junior answers for what it did with each directive.
- **Batches**: runs compared by condition, from what their researchers found, with their uncertainty, control charts
  across batches and frozen references to compare with.
- **Project planner**: pursues a question in a loop (hypotheses with predictions, a batch, a synthesis) until a computable
  criterion holds or the budget is spent, with the operator approving its plans.
- **Research in parallel** (`SPEC-INVESTIGACION-PARALELA.md`), a separate condition that measures the collective system,
  never one researcher: exploration boards of a family, and **teams** of researchers publishing results, dead ends and
  methods to a board they read by windows.
- **Delegation** (`SPEC-DELEGACION-INVESTIGACIONES.md`): an investigation opens **branches** - another investigation with
  its own question, budget and fund - and takes back what they found as evidence it can check. One kind of branch is an
  **evolutionary search over programs** (`SPEC-DELEGACION-EVOLUTIVA.md`): a population of candidates, a fixed evaluator,
  repair, diversity and quotas, its record rebuilt with no model.

## Living worlds

In a living world (`SPEC-ACONTECIMIENTOS-DEL-MUNDO.md`) the world does not wait: it advances by **windows**, its actors
(researchers, simulated services, an external world) act at the same time, **programmed events** and signals change it,
and a researcher can set **watchers** that wake it when something happens. Several researchers can share one session,
with messages ordered by window, forks and shared branches; a senior can follow a shared session and is woken by what
happens in it. Every session is recorded with identity hashes and can be **rebuilt from its record**, compared with
another and packed. `lab live <manifest>` runs one; `lab world` lets the operator pause, resume, add programs, speak to a
member or retire it. The first world is `plates`.

## Learning to research better

The **research meta-policy** (`SPEC-METAPOLITICA-INVESTIGACION.md`) asks whether a procedure for researching can be
learned, without touching the researcher's weights:

- **M1, a policy:** `research-policy@1` - observations in code over what the junior lived up to a cut, rules the Judge
  answers, a composition that advises *develop*, *contrast* or *reframe*, or abstains - delivered as advice through the
  channel, paid from the budget of help, and rebuilt exactly from the record.
- **M2, its evaluation:** a policy is measured by **whole investigations** of a junior in worlds and realizations fixed
  beforehand (research trials), never by grading its prose; a fund reserves every trial before it runs; an evolutionary
  engine searches over policies, and `lab meta verify` rebuilds a search with no model.
- **M3, the pilot:** prepared (`lib/examples/meta.pilot.md`), with a fixed reminder and a situated candidate against the
  junior alone and the senior. Not launched yet.

## Learning to learn: a junior that improves itself

The **learning meta-policy** (`SPEC-METAPOLITICA-APRENDIZAJE.md`) lifts the last restriction: the researcher's own
weights, memory and procedure become levers. Its junior is [Qwenputer](https://github.com/divagr18/qwenputer): Qwen3.5-4B
with a RISC-V computer compiled into layers in front of Qwen's, and a file system that lives in the recurrent state of
those layers. Writing a file changes state, not weights; the computer is exact, and must stay so.

**Phase A**, implemented: a strong model, configured as any researcher, improves the junior in an artifact world whose
artifact is the junior (`junior-competence@1`).

- **The junior, packaged and served** (`junior-package@1`): weights, adapter, prompt, initial memory, decoding and its
  execution - driver, tokenizer, firmware - by full hashes; served in sessions with idempotent receipts, its memory
  states chained and **verified with no model**: a reference rebuilds the stream and the memory's twin, and the compiled
  circuit, run on the recorded stream, must leave exactly the neural snapshot published.
- **A ladder of competences**: protocol, requests, the harness's rules, a checkable model, method, and the worlds
  solved - measured on fixed **probes** (a cut of a real run, the junior's answer judged by the harness's own contract
  at that point) and whole investigations; a candidate is **promoted** case by case against the reference
  (`paired-cases@1`), never by one mark.
- **Levers**, cheapest first: its prompt and decoding; files it writes into its own memory; memories published from its
  investigations; **distillation from a cut** (the strong model answers where the junior failed, its memory served by a
  simulator, the example accepted only when the harness's checker says so); and **LoRA on Qwen's layers only**, the
  circuit frozen and checked exact before any evaluation.
- **Confirmation out of its reach**: the operator's service evaluates frozen packages on reserved cases, publishes only a
  summary, and stops using cases once they have been exposed too often.
- **A reusable method** (`learning-policy@1`): procedures that advise the strong researcher through M1, compared by whole
  improvement investigations.

**Phase B**, the handover - the junior taking control of its own learning - is defined and off until its threshold is set
from phase A's evidence. Phase A is waiting for its first real runs, on a machine with two GPUs
([setup guide](lib/examples/junior.setup.md)).

## Measuring

Several metrics, read side by side and never combined into one mark:

- **The outcome**: whether the model holds in the checks, validates on worlds that share the rule, and is accepted by
  blind worlds. Where a world has a hidden truth, the operator also grades how much of it the researcher recovered.
- **The method** (`SPEC-AUDITORIA-METODO.md`): whether the researcher chains its instruments as a scientific method:
  hypothesis → an experiment that tells it apart → the result read right → a belief updated in proportion. `lab audit`
  reconstructs each experiment from the journal; **code observes** and **the Judge answers closed questions**, and the
  Judge is **calibrated against a person** (Cohen's kappa per question) before its answers are trusted.
- **The climb** (`SPEC-VISTA-ESCALADA.md`): every metric a world offers is a mountain the researcher climbs - the share
  of places where the model holds, the correctness and cost of an artifact against its reference - drawn for several
  researchers at once, with the help each received drawn as ropes, replayable round by round and exportable.
- **Evidence a person can check**: `lab pack` turns a run into a research package (its record, its blobs, a manifest of
  hashes), and `lab verify` rebuilds its history offline; `lab model` keeps a validation record of an accepted model -
  revisions, approvals by a person, an inventory with its dependencies and a re-evaluation when they change
  (`SPEC-RIESGO-MODELOS.md`).

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
   Connect Four: the search won for it. The discriminating measures are rule recovery and checks on starts never played.
3. **A judge that sees only the researcher's observations works as an attention mechanism** *(strong signal)*. Removing
   the picture from the judge turned it from a net cost into a net gain against a code-only ablation and cut its calls
   from ~9000 to ~650.
4. **Errors in the instrument become false beliefs** *(solid)*. Draws labelled as losses, verdict labels and duplicated
   games each led the researcher to drop correct ideas. The fix was always the same: facts, not verdicts.
5. **A senior paired with a cheaper junior is a good pair** *(signal)*. GPT-6 Luna with a GPT-6 Sol senior held 8/8 in
   round 8 for about $0.33, against $1.29 for Sol alone (7/8). The senior's best contributions were new hypotheses with an
   experiment to test them; its worst, a fact it misread from a picture, which the junior then refuted by looking.
6. **Researchers backtrack on their own** *(signal)*. After a refinement broke a model that held, the researcher replayed
   its earlier model from the new failing starts as a baseline and concluded that neither generalized.
7. **The same harness evolves an artifact** *(signal)*. In 3SUM, researchers took the program from cubic to quadratic and
   then to variants below quadratic for bounded ranges, without reaching the general sub-quadratic algorithm; the
   algorithmic ideas came mostly from the senior, with the junior executing them.
8. **An evolutionary branch opens another line of research** *(signal)*. In 3SUM runs stuck in a local minimum, the search
   proposed mechanisms the researcher had not, and the researcher adopted one and worked on it - finding and repairing an
   error, contrasting it - though no artifact was accepted.
9. **Generic method guidance changes behaviour without leaking the environment** *(signal)*, and the model matters more
   than the prompt for bottlenecks such as over-caution or long contexts.

Failure modes seen: pretraining priors (an imagined Connect Four), over-caution with complete evidence, anchoring on a
noisy score, understanding a rule without carrying it into the model, leaving instruments unused, stating as a fact what
was a misreading, and a junior that waits for its senior's plan instead of testing its own ideas.

**The thesis under test:** if a researcher generalizes to worlds it has never seen, LLMs have latent ability to do
science, and what they lack are instruments and a method like these. The full account is in [INFORME.md](INFORME.md).

## Repository

| Path | What it is |
|---|---|
| [`lib/`](lib/README.md) | `neurosym`, the TypeScript core with no runtime dependencies |
| `lib/src/core/` | World, Observer, Formula, Judge (Jev), Evaluator, Search, the predictor and a model's output code |
| `lib/src/learn/` | the common prompt, the explorer and law sessions (the researcher's protocol), notebook, objective and protocol (check, validation, blind confirmation), findings, anomalies |
| `lib/src/learn/assisted/` | the assisted researcher: message channel, sources, selective memory, experience, own instruments and tests, delegation, the team board, research policies (M1) |
| `lib/src/learn/evolve/` | the evolutionary engine: populations, evaluators, repair, and the verification of a search |
| `lib/src/worlds/` | the laboratories: `grid`, `orbit`, `cells`, `messages`, `tank`, `particles3d`, `c302nav`, `c302closed`, `artifacts`, `plates`, `junior` (and `foxhounds`, the original known game) |
| `lib/src/artifacts/` | the artifact world: versions by content, a process sandbox, tasks and their verdicts |
| `lib/src/living/` | living worlds: sessions by windows, actors, events and signals, external worlds, their record and its reconstruction |
| `lib/src/orchestra/` | agent operators and the senior, batches, control charts and references, the project planner, teams |
| `lib/src/meta/` | the meta-laboratory (M2): the corpus of records, research trials, the evaluator of policies |
| `lib/src/junior/` | the learning meta-policy's phase A: the junior's package, server, verifier, proxy, measures, probes, memory, distillation, training, confirmation and learning policies (with its Python worker, verifier and trainer) |
| `lib/src/audit/` | the method audit: links and code observations, the Judge's questions, claim extraction and fact checks, calibration |
| `lib/src/runtime/` | the common runner, control API, CLI, replay log, regrading, packages and their verification |
| `lib/src/console/` | the research observatory and the climb view |
| `lib/src/view/`, `journal-viewer.html` | the journal viewer: an animated synthesis of a finished run |
| `lib/scripts/` | runners, calibrators that find seeds worth learning, services (tank, Blender, c302, the junior's server, the providers' proxy), the console, the bundle |
| `lib/examples/` | manifests, batches, policies and guides ready to run (`meta.pilot.md`, `junior.setup.md`, …) |
| `INFORME.md`, `EVAL-UNKNOWN-WORLD.md`, `SPEC-*.md` | the report and the specifications (Spanish) |

## Running it

Requires Node ≥ 22.6.

```bash
cd lib && npm install && npm test
```

Endpoints and keys come from the environment only: `LLM_URL` (any OpenAI-compatible `/chat/completions`), `LLM_MODEL`,
`LLM_KEY`, and `JEV_KEY` (optionally `JEV_URL`, `JEV_MODEL`) for the judge; the senior, planner, grader and audit's
extractor take `SENIOR_LLM_*`, `PLANNER_LLM_*`, `GRADER_LLM_*` and `AUDIT_LLM_*` (connection/model default `LLM_*`), and
the junior's teacher `TEACHER_LLM_*`. Old `AGENT_LLM_*` variables remain aliases of `SENIOR_LLM_*`; when both are set, the
new names win. The easiest way is a launcher: copy `lib/lab.example.ps1` (or a `run-<world>.example.ps1` / `.sh`) to the
same name without `.example`, fill in your keys (those names are git-ignored), and pass any option through. `--flat` runs
any world with a judge that knows nothing, without a key.

For OpenAI reasoning models, set `LLM_REASONING_EFFORT` for the junior and `SENIOR_LLM_REASONING_EFFORT` for the senior
independently. For example, `LLM_MODEL=gpt-6-luna`, `LLM_REASONING_EFFORT=low` and `SENIOR_LLM_REASONING_EFFORT=high`
use the same model with different effort. Neither effort setting inherits from the other; unset means the provider's
default. Values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, subject to the model's supported values
(GPT-6.1 Sol does not support `none` or `minimal`; GPT-6 Sol/Luna do not support `minimal`). Explicit effort is sent as
top-level `reasoning_effort`; active reasoning omits incompatible `temperature`, `top_p`, `logprobs` and `top_logprobs`.
With explicit effort, completion limits use `max_completion_tokens`, including reasoning tokens.
`LLM_EXTRA_BODY` keeps its existing Qwen/vLLM behaviour when no OpenAI effort is set. Senior tuning uses its own
`SENIOR_LLM_EXTRA_BODY`, `_TEMPERATURE`, `_MAX_TOKENS`, `_JSON_MODE` and `_TIMEOUT_MS`, without inheriting junior tuning.

For vLLM/Qwen, set each role's extra body separately using the served model's template options. For the existing
`chat_template_kwargs.reasoning_effort` configuration, the same model can receive `low` as junior and `high` as senior:

```powershell
# Clear OpenAI-specific effort overrides if this shell previously used them.
Remove-Item Env:LLM_REASONING_EFFORT, Env:SENIOR_LLM_REASONING_EFFORT -ErrorAction SilentlyContinue
$env:LLM_EXTRA_BODY = '{"chat_template_kwargs":{"reasoning_effort":"low"},"top_p":0.95,"top_k":20}'
$env:SENIOR_LLM_EXTRA_BODY = '{"chat_template_kwargs":{"reasoning_effort":"high"},"top_p":0.95,"top_k":20}'
$env:LLM_TEMPERATURE = "1"
$env:SENIOR_LLM_TEMPERATURE = "1"
```

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
`--sources-allow`, `--experience <journals> [--experience-mode meta] [--experience-scope methods]`,
`--research-policy <file>` and `--delegation-fund N` for the assisted researcher. `--help` lists each world's own options.

Some worlds need a service of their own:

```bash
node --experimental-strip-types scripts/tank-service.ts --port 18300
node --experimental-strip-types scripts/particles3d-service.ts --port 18500      # Blender
node --experimental-strip-types scripts/c302-service.ts --python <python>        # c302 and NEURON
```

### Agents, batches, projects, teams, living worlds

```bash
lab agent last --role senior                       # a senior follows the run (start it with --agents senior=message)
lab batch examples/batch.example.json
lab project start examples/project.example.json
lab team examples/team.example.json
lab live examples/living.plates-pilot-pair.json    # a living world's shared session
lab world <session> status                         # and its control by the operator
```

### Meta-policies

```bash
lab meta index | inspect | trials | search | verify ...        # the research meta-policy (see examples/meta.pilot.md)
lab junior package | verify | cut | manifest | evaluate | promote | confirm | policy ...
                                                               # the learning meta-policy (see examples/junior.setup.md)
```

### Grading, auditing and evidence

```bash
lab grade <run>                                    # grade the recovered rule again, with GRADER_LLM_*
lab audit <run> --flat                             # the method: what code observes, no cost
lab audit <run> --extract                          # plus the Judge's answers and the checked claims
lab audit sample <run> --n 30                      # a blind sample to label; then: lab audit agreement labels.json
lab pack <run>                                     # a research package; lab verify <package> rebuilds it offline
lab model register <run> --owner "<person>"        # a validation record of an accepted model
```

### Consoles and viewers

```bash
node --experimental-strip-types scripts/lab-console.ts
```

Opens `http://127.0.0.1:18400`, the classic console (start, follow, stop, resume, message runs, projects) and
`/research`, the observatory: what each researcher is doing now, the trajectory by rounds, the evidence, text queries over
a fixed cut of the record, an analyst of the record, and the **climb** of several researchers on one mountain.

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

The specifications are contracts written before the code and reconciled with external reviews; the status line at the
top of each says how far it was built (some predate their implementation and lag behind the code).

| Document | About |
|---|---|
| [INFORME.md](INFORME.md), [EVAL-UNKNOWN-WORLD.md](EVAL-UNKNOWN-WORLD.md) | the report, and how to evaluate the unknown-world researcher |
| [SPEC-OBJETIVO.md](SPEC-OBJETIVO.md), [SPEC-MODELO-DEL-MUNDO.md](SPEC-MODELO-DEL-MUNDO.md) | the objective as a contract; discovering rules and validating them |
| [SPEC-MUNDO-FISICO.md](SPEC-MUNDO-FISICO.md), [SPEC-MUNDO-3D.md](SPEC-MUNDO-3D.md) | the physical world, and particles in 3D simulated by Blender |
| [SPEC-EUREKA-NAVEGACION.md](SPEC-EUREKA-NAVEGACION.md), [SPEC-C302-LAZO-CERRADO.md](SPEC-C302-LAZO-CERRADO.md) | c302 from EurekaBench as a world of the harness, and its closed loop |
| [SPEC-MUNDO-ARTEFACTOS.md](SPEC-MUNDO-ARTEFACTOS.md) | the artifact world: building and optimizing with the scientific method |
| [SPEC-ACONTECIMIENTOS-DEL-MUNDO.md](SPEC-ACONTECIMIENTOS-DEL-MUNDO.md) | living worlds: actors, events and reactive research |
| [SPEC-INVESTIGADOR-ASISTIDO.md](SPEC-INVESTIGADOR-ASISTIDO.md), [SPEC-CANAL-MENSAJES.md](SPEC-CANAL-MENSAJES.md) | the two researchers; the one channel for everything that reaches System 2 |
| [SPEC-INSTRUMENTOS-PROPIOS.md](SPEC-INSTRUMENTOS-PROPIOS.md), [SPEC-PRUEBAS-PROPIAS.md](SPEC-PRUEBAS-PROPIAS.md) | the researcher's own instruments, and its preregistered tests |
| [SPEC-CALIBRACION-INSTRUMENTOS.md](SPEC-CALIBRACION-INSTRUMENTOS.md) | when reality may be a bug: calibrating instruments and reporting anomalies |
| [SPEC-ORQUESTADOR.md](SPEC-ORQUESTADOR.md), [SPEC-INVESTIGACION-PARALELA.md](SPEC-INVESTIGACION-PARALELA.md) | agent operators, the senior, batches, the planner; research in parallel |
| [SPEC-DELEGACION-INVESTIGACIONES.md](SPEC-DELEGACION-INVESTIGACIONES.md), [SPEC-DELEGACION-EVOLUTIVA.md](SPEC-DELEGACION-EVOLUTIVA.md) | delegating an investigation from another, and evolutionary search as a branch |
| [SPEC-METAPOLITICA-INVESTIGACION.md](SPEC-METAPOLITICA-INVESTIGACION.md), [CATALOGO-METAPOLITICAS-INVESTIGACION.md](CATALOGO-METAPOLITICAS-INVESTIGACION.md) | learning a research meta-policy, and a catalogue of research methods |
| [SPEC-METAPOLITICA-APRENDIZAJE.md](SPEC-METAPOLITICA-APRENDIZAJE.md) | the learning meta-policy: a small model that learns to improve itself |
| [SPEC-AUDITORIA-METODO.md](SPEC-AUDITORIA-METODO.md), [SPEC-VISTA-ESCALADA.md](SPEC-VISTA-ESCALADA.md), [SPEC-CONSOLA-INVESTIGACION.md](SPEC-CONSOLA-INVESTIGACION.md) | the method audit; the climb view; the research observatory |
| [SPEC-CONTROL-ARNES.md](SPEC-CONTROL-ARNES.md), [SPEC-RIESGO-MODELOS.md](SPEC-RIESGO-MODELOS.md) | the harness as a controlled process; model risk and validation evidence |
| [COMPARACION-LOCAL-AUTORESEARCH.md](COMPARACION-LOCAL-AUTORESEARCH.md) | what this harness shares with local-autoresearch, and what to take from it |
| [SPEC-RULENET.md](SPEC-RULENET.md), [SPEC-APRENDIZAJE-DIFFS-Y-ACCIONES.md](SPEC-APRENDIZAJE-DIFFS-Y-ACCIONES.md) | earlier work: semantic rule networks; learning from diffs and explicit actions |

## License

[MIT](LICENSE)
