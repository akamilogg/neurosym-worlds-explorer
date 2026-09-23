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
| **Evaluator** | `Eval(formula, s)`: observar → juzgar → componer, caché por vector `O(s)` | `core/evaluate.ts` |

El dominio vive sólo en `worlds/<id>/`: `foxhounds@1` trae el mundo, su **dialecto** (el antiguo
catálogo `OBSERVATION_OPS`) y un importador de los exports del harness.

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

## Validación

```
npm test            # paridad con el harness original + modos + Eval
npm run typecheck
```

Los tests de paridad cargan `../fox-hounds-harness.html` tal cual y comparan, sobre ~10 700 estados
alcanzables: reglas del mundo, los 12 ops del catálogo y la fórmula aceptada en el run del 21/09
(`runs/2026-09-21-run-journal.json`). Además demuestran que el modo `code` reescribe desde las
reglas del mundo (sin el dialecto) las medidas estratégicas del catálogo, con valores idénticos.

## Hoja de ruta

| Fase | Contenido | Estado |
|---|---|---|
| **P0** | Núcleo: World, Observer (code/dsl), Formula, Evaluator; `foxhounds@1` con paridad | **hecho** |
| P0b | Juez Jev (`/v1/systemone`, relay), búsqueda (minimax/fan-out/PV-αβ), oráculo como capacidad del World; el harness consume la biblioteca | pendiente |
| P1 | System 2 escribe medidas `code`: prompt, replay sobre la evidencia, chequeo de determinismo, telemetría "la medida absorbe el juicio" | pendiente |
| P2 | Ablaciones con las mismas semillas: catálogo vs code vs ambos; juez lineal sólo como línea base | pendiente |
| P3 | Un segundo World, pequeño y distinto: sin él no hay biblioteca | pendiente |
