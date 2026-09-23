# neurosym · núcleo portable del harness neuro-simbólico

Extraído de `fox-hounds-harness.html` (P0, 23/09/2026). TypeScript sin dependencias de runtime;
corre en Node ≥ 22.6 (`--experimental-strip-types`) y en navegador.

## Objetivo

**Interpretabilidad del mecanismo de búsqueda.** La evaluación de un estado es una fórmula que
se puede leer entera:

```
V(s) = Σ_i w_i · r_i(O(s))
        │        │    └─ O(s): hechos medidos por CÓDIGO (determinista, legible por humanos y máquinas)
        │        └────── r_i: reglas en lenguaje humano que juzga Jev (System 1 semántico)
        └─────────────── w_i: composición en código
```

Código y Jev están **ambos presentes**: el código observa, Jev juzga. Una medida en código puede
calcular lo que quiera (no hay tope de cómputo), pero es preferible que el juicio viva en una regla
de Jev y no dentro de una función: una regla semántica se entiende mejor que una función compleja.
System 2 (un LLM) es quien propone la fórmula; nunca calcula valores ni elige jugadas.

## Las piezas (sólo una conoce el dominio)

| Pieza | Contrato | Fichero |
|---|---|---|
| **World** | `initial · toMove · actions · step · pass? · outcome · key · view · describeRules` | `core/types.ts` |
| **Observer** | ejecuta `O(s)`: medidas `code` o `dsl`, refusa con motivo lo que no admite | `core/observer.ts` |
| **Judge** | `r_i(O(s)) ∈ [0,1]` con confianza (Jev) | `core/types.ts` (interfaz) |
| **Formula** | el artefacto JSON portable; hash semántico; gate estructural; composición | `core/formula.ts` |
| **Evaluator** | `Eval(formula, s)`: observar → juzgar → componer, caché por vector `O(s)` que agrupa peticiones en vuelo; terminales por las reglas; prior de política | `core/evaluate.ts` |
| **JevJudge** | `POST /v1/systemone` (directo o relay), reintentos con backoff/Retry-After, semáforo de concurrencia, lectura tipada de respuestas | `core/jev.ts`, `core/net.ts` |
| **Search** | minimax con profundización iterativa: `learning-fanout` (exhaustivo, evidencia) y `play-pv-alpha-beta` (poda exacta); TT con cotas; `onLeaf` para el aprendiz | `core/search.ts` |

El dominio vive sólo en `worlds/<id>/`: `foxhounds@1` trae el mundo, su **dialecto** (el antiguo
catálogo `OBSERVATION_OPS`), el **modelo del ratón** (planner code-only), el **oráculo** (verdad contra
ese modelo) y un importador de los exports del harness.

```ts
const model = createMouseModel(5);
const ev = new Evaluator(new Observer(foxhounds, { dialects: [foxhoundsDialect] }),
  new JevJudge({ url, apiKey, model: 'jev-latest' }),
  { maximizer: 'cats', context: () => ({ id: model.id, facts: { opponent: model.describe() } }) });
const { best } = await searchBestMove(ev, state, { formula, depth: 5, respond: (s) => model.respond(s) });
```

## Modos de observación (los elige el diseñador del experimento)

```ts
new Observer(world, { kinds: ['code'] })                              // sólo Eval: System 2 escribe funciones
new Observer(world, { kinds: ['dsl'], dialects: [foxhoundsDialect] }) // sólo DSL: core@1 + dialectos del diseñador
new Observer(world, { dialects: [foxhoundsDialect] })                 // ambos (por defecto)
```

- **`code`** — `{kind:"code", lang:"js", source:"(ctx) => number", range}` con
  `ctx = {view, state, world}`. Función pura: sin `Math.random`, reloj, timers, red ni globals.
  El runner portable (`jsFunctionRunner`) es higiene, no aislamiento; en Node, `nodeVmRunner`
  aísla en un contexto V8 propio. Un host sin runner para `lang` refusa la medida.
- **`dsl`** — `{kind:"dsl", dialect, ...}`.
  - `core@1`: AST JSON neutral (agregados sobre entidades, escalares, aritmética, `call` a ops de
    otro dialecto). Sus límites (64 nodos, profundidad 8) son de **legibilidad**, no de cómputo.
  - Dialectos del diseñador: `opDialect(id, ops, worlds)` convierte una tabla de ops documentadas
    en vocabulario. `foxhounds@1` es uno; varios de sus ops (`mouse_routes`, `covered_mouse_moves`)
    codifican estrategia del diseñador, por eso es un plugin y no parte del núcleo.

`observer.describe()` devuelve exactamente el vocabulario del experimento (lo que se le enseña al autor).

## El artefacto

```json
{ "format": "neurosym.formula", "format_version": 1, "world": "foxhounds@1",
  "observations": { "<id>": { "name", "definition", "spec": { "kind": "code" | "dsl", ... }, "range": [lo, hi] } },
  "rules": { "<id>": { "type", "used_as", "option", "instructions": "... {{<obs id>}} ...", "criteria" } },
  "weights": { "<value rule id>": w }, "policy_weights": {}, "confidence_floor": 0.45,
  "meta": { "version", "rationale", "source" } }
```

`meta` nunca entra en el hash. `judgmentHash` excluye los pesos: las respuestas del juez se reutilizan al re-pesar.

## El harness consume la biblioteca

`fox-hounds-harness.html` sigue siendo UN fichero: `npm run bundle` compila `src/browser.ts` a un IIFE
(global `Neurosym`) y lo incrusta al principio de su único `<script>`, entre dos marcadores
(`npm run bundle:check` falla si el bundle incrustado está desfasado; un test lo vigila).

Hoy el harness delega en la biblioteca **el mundo y el vocabulario**: reglas (`legalMovesForSide`,
`applyMove`, `passTurn`, `isTerminal`, `stateKey`, `moveKey`, ataques, tablero ASCII), el catálogo
`OBSERVATION_OPS` (= dialecto `foxhounds@1`) y el planner del ratón (`solveLookahead`, greedy). Su
orquestación (bucle de aprendizaje, jueces, journal, telemetría, UI, búsqueda y llamada a Jev con
sus contadores) sigue en el HTML: la biblioteca tiene ya sus equivalentes con paridad demostrada, y
se sustituirán cuando la orquestación se extraiga.

## Validación

```
npm test            # paridad con el harness de referencia + modos + Eval + búsqueda + embed
npm run typecheck
node ../fox-hounds-harness.selftest.js   # el harness con la biblioteca dentro (342 checks)
```

Los tests de paridad cargan el harness **del commit base** (`3deded1`, el código que produjo el run
del 21/09) y comparan:
- reglas del mundo (~10 700 estados), los 12 ops, la fórmula aceptada del run (`runs/…json`);
- el planner del ratón (greedy y profundidades 1-4) y el oráculo (ganador, plies, motivo, agotamiento);
- la **búsqueda completa** con el mismo stub de Jev en ambos lados, en aprendizaje y en PLAY: misma
  jugada, mismo `V(s)`, misma línea, mismas hojas, nodos y cortes, y **las mismas preguntas a Jev byte
  a byte** (salvo la etiqueta del hash de fórmula).

Además demuestran que el modo `code` reescribe desde las reglas del mundo (sin el dialecto) las
medidas estratégicas del catálogo, con valores idénticos.

**Hallazgo medido (P0b):** en las mismas búsquedas el harness hizo 219 llamadas a Jev para 103
preguntas distintas (aprendizaje) y 193 para 163 (PLAY). Hojas con el mismo `O(s)` lanzadas a la vez
en el fan-out salen antes de que la primera respuesta llene la caché, y el harness no agrupa peticiones
en vuelo. La biblioteca sí: paga cada pregunta una vez. (Stub determinista, profundidad 3; en un run
real la proporción dependerá de cuántas hojas comparten vector.)

## Hoja de ruta

| Fase | Contenido | Estado |
|---|---|---|
| **P0** | Núcleo: World, Observer (code/dsl), Formula, Evaluator; `foxhounds@1` con paridad | **hecho** |
| **P0b** | Juez Jev, búsqueda (fan-out / PV-αβ), modelo del ratón y oráculo con paridad; el harness incrusta la biblioteca y le delega mundo, vocabulario y planner | **hecho** |
| P0c | Extraer la orquestación: el harness usa `Evaluator`/`searchBestMove`/`JevJudge` de la biblioteca (y hereda la agrupación de peticiones en vuelo) | pendiente |
| P1 | System 2 escribe medidas `code`: prompt, replay sobre la evidencia, chequeo de determinismo, telemetría "la medida absorbe el juicio" | pendiente |
| P2 | Ablaciones con las mismas semillas: catálogo vs code vs ambos; juez lineal sólo como línea base | pendiente |
| P3 | Un segundo World, pequeño y distinto: sin él no hay biblioteca | pendiente |
