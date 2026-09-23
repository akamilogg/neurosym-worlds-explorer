# SPEC · Aprendizaje por diffs, juicio/consenso y acciones explícitas

**Fichero:** `SPEC-APRENDIZAJE-DIFFS-Y-ACCIONES.md`
**Ámbito:** `fox-hounds-harness.html` + `fox-hounds-harness.selftest.js`
**Estado (19/09/2026, fase 4):** M-C-01 **HECHO** · M-A-13 + auditoría del contrato (§6) **HECHO** ·
**M-B-02 HECHO** · **SPEC-01 (M-A-01…M-A-12) HECHO** · **M-D (modelo del ratón + currículum + gate de
evidencia + journal, §8) HECHO** · **F1–F6 (post-run del 19/09) HECHO** · **Intervención del operador
(botón "Force System-2 consult" + directiva, §9) HECHO** · **M-B-05 · lectura del tablero obligatoria
(§10) HECHO** · SPEC-02 y el resto de M-B **en propuesta**.
**Documento hermano:** `INFORME.md` (diagnóstico del run, cifras medidas, qué falta y limitaciones).
**Criterio de aceptación (intacto):** el rule set se acepta sólo si los gatos ganan **todos** los
juegos de prueba con el conjunto congelado (`verifyRulesCleanly`). La **dificultad de la medición**
sí escala: ver §8.

---

## 0. Invariantes que ninguna spec rompe

| ID | Invariante | Dónde vive |
|---|---|---|
| I1 | El artefacto de aprendizaje es SIEMPRE un rule set evaluable por Jev (instrucciones, criterios, tipo/rol, pesos, floor). La prosa no se evalúa. | `hasEvaluableRuleChange`, `diffRuleSets` |
| I2 | El harness no inventa valores ni opiniones: sin Jev no hay valor; sin oráculo no hay verdad. | `evaluateWithJev`, `oracleVerdict` |
| I3 | El harness no tiene opinión sobre jugadas: el prior ordena, nunca recorta. | `orderMoves`, doc del análisis minimax |
| I4 | Toda mutación intra-juego es hipótesis, no medición: se re-verifica limpia antes de aceptar. | `verifyRulesCleanly`, `match.measurementGame` |
| I5 | Lo que se reporta al operador son MEDIDAS, no estimaciones. | `Telemetry.snapshot()`, diagnósticos |

**No-objetivos:** cambiar el criterio de aceptación; introducir un evaluador local. El oponente
dejó de ser "intocable" por **enmienda M-D (18/09/2026, §8)**: sigue siendo UN modelo determinista
que el operador nunca puede redefinir, pero su **profundidad de planificación** es un knob declarado
que el currículum escala mientras las reglas ganan. El criterio de aceptación sigue intacto.

---

## 1. SPEC-01 · Aprendizaje por diffs con juicio/consenso (IMPLEMENTADO)

**Estado: HECHO (2026-09-18)** — M-A-01…M-A-11 implementados y M-A-12 verde (los checks están en el
selftest y en el motor). Resumen de lo que quedó en el código:
`recordRevision`/`jevBeliefBaseline` (journal de revisiones, 0 llamadas) · `mergeRevisions`/`viewRevisions`
(por estado, no por fila) · `buildAtomWitness`/`truthLabelCounts`/`buildRevisionDigest` (payload
`revision_digest`) · `toRuleDiff` (diff tipado) · `judgeRuleDiffMeasured` (J1/J2) ·
`judgeRuleDiffConsensus` (J3, quórum declarado, rationale-blinding) · `narrowRuleSet` (veredicto `narrow`) ·
cableado en **los dos** puntos de mutación (`maybeCourseCorrect` y `consolidateReflections`) ·
contadores `judgeCalls/Approved/Rejected/Narrowed/QuorumMiss` + tile `Judges`.



### 1.1 Modelo de datos

- **M-A-01 `Revision`** (diff de EVIDENCIA, coste 0 llamadas): por estado re-visitado donde el juicio
  de Jev cambió respecto al valor previo conocido (`ctx.valueHints` / TT):
  `{ state_key, ply, side_to_move, prev_V, new_V, delta_V, prev_atoms, new_atoms, atom_delta,
  confidence, source, oracle, root_move }`. Sin valor previo ⇒ `first_seen: true` (no es revisión).
- **M-A-02 `Witness`**: agregado **por pregunta** (no por línea) reutilizando
  `Telemetry.noteAtomTruth`/`atomAccuracy` (DRY).
- **M-A-03 `RuleDiff`**: la propuesta de System 2 como **lista tipada de campos**
  (`weights`, `confidence_floor`, `instructions`, `criteria`, `type`, `used_as`, `added`, `removed`).
  Los `kind` ya existen en `ruleChangeKinds`/`diffRuleSets` y `EVALUATED_QUESTION_FIELDS`.
- **M-A-04 `Verdict`**: `{ decision: apply|reject|narrow, applied_fields, judge, votes, reason }`.

### 1.2 Flujo

```
leaf → Revision (0 llamadas) → Witness por pregunta (0 llamadas)
     → courseCorrectionTrigger → presupuesto de consultas → JUECES
     → prefilterCandidate + hasEvaluableRuleChange → apply | narrow | reject
     → (si aplica) re-search del ply → contadores + log greppable
```

- **M-A-05**: un `reject` no descarta evidencia: casos y witness se encolan para el siguiente intento.
- **M-A-06 · Jerarquía de jueces (orden obligatorio)**
  1. **J1 Medición**: contradicción con el oráculo / prefilter de decidibilidad ⇒ decide sin opinión.
  2. **J2 Replay medido**: el diff debe ser estrictamente más decisivo en las líneas del trigger.
  3. **J3 Consenso del modelo**: SÓLO si J1/J2 callan (`oracle.known === false` y prefilter empata);
     N-de-M con `JUDGE_QUORUM`, rationale **oculta** al juez (rationale-blinding) para no ser un eco.
  4. **J4 Juegos + re-verificación limpia**: juez final, sin cambios.
- **M-A-07**: el juez de consenso recibe sólo el diff, el witness medido, las líneas del trigger y el
  veredicto del oráculo: **nunca** la `rationale` del proponente.
- **M-A-08**: presupuesto propio de consenso (`tuningConsensusPerGame`), separado del de consultas.
- **M-A-09 `narrow`**: aplica un subconjunto; si el diff mezcla pesos con instrucciones/criterios,
  sólo se aplica lo que J2 puede medir y el resto se encola.
- **M-A-10/11**: contadores `judgeCalls/Approved/Rejected/Narrowed/QuorumMiss/revisionsRecorded/
  witnessesBuilt/revisedAtoms`, tiles `JUDGE`/`REVISIONS`, líneas greppables `JUDGE APPROVED…`,
  `REVISION JOURNAL at ply N…`, y `revision_digest` en el payload.
- **M-A-12 · Tests**: 7 checks (first_seen no cuenta; witness sin muestras ⇒ `informative: null`;
  prefilter menos decisivo ⇒ reject sin re-búsqueda; contradicción ⇒ apply sin consenso; quórum
  insuficiente ⇒ reject; `narrow` sólo campos medibles; la rationale no aparece en el payload del juez).
- **M-A-13 · Honestidad del contrato — HECHO (2026-09-18).** El prompt/schema anunciaba dos cosas que
  el motor no hace: *"orders the search (and, if the operator enables it, narrows it)"* (capacidad
  retirada: `narrowMoves`/`policyWidth` no existen y el selftest los prohíbe) y
  `"confidenceFloor": <number in [0.5,0.95], below this the harness re-asks you>` (el gate acepta
  `[0.3,0.95]` y el trigger por confianza se retiró). Ambos textos corregidos, el rango se **renderiza
  desde `CONFIDENCE_FLOOR_RANGE`** (no puede volver a driftar) y dos checks nuevos lo bloquean
  (estático sobre el fichero + comportamiento sobre el prompt construido). Ver §6 para el resto del
  audit que salió de aquí.
- **Riesgos**: consenso correlacionado (mismo `llmUrl`) ⇒ mitigado con medición primero y
  rationale-blinding; menos adaptación ⇒ medible con el contador de rechazos; re-litigación ⇒ hash del
  ---

## 2. SPEC-02 · Acciones explícitas de System 1 (propuesta)

- **M-B-01**: ya existe la distribución sobre acciones (`materializeQuestions` materializa las opciones
  desde `legalMovesForSide`, con clave `moveKey`). No se reinventa.
- **M-B-02 (bloqueante) · HECHO**: el `Math.max` por movimiento desapareció. Ahora cada pregunta de
  política declara `aggregate: "single" | "weighted_mean"` (validado en `normalizeQuestion`) y el rule set
  lleva un mapa **`policyWeights`** aparte de `weights` (deliberadamente separado: meter ids de política en
  `weights` haría que `composeLeafValue` los contara como 0.5 neutral en cada hoja). La fusión vive en una
  única función pura, `mergePolicyDistributions(entries, mode, policyWeights)`: `single` = decide la primera
  pregunta declarada y las demás se reportan como ignoradas; `weighted_mean` = media ponderada de las
  distribuciones normalizadas (movimiento ausente = 0, renormalizada después). `policy_weights` y
  `aggregate` son campos **evaluables** (kind propio y entrada en `EVALUATED_QUESTION_FIELDS`), así que
  cambiarlos cuenta como aprendizaje; el prompt, el shape, `toWireRules` y `battery_in_use` los documentan.
- **M-B-03 · Verdad de acción**: `solveAgainstGreedy` calcula el mejor hijo por nodo y hoy **descarta
  qué movimiento lo produjo**; propagarlo permite exponer `best_move`/`winning_moves` desde
  `oracleVerdict`. Hallazgo: en posiciones perdidas conserva el primer hijo ⇒ `plies` no mide demora
  (**M-B-03b**, opcional).
- **M-B-04 · `ACTION ACCURACY`**: sobre plies con veredicto conocido (≥ `ACTION_ACCURACY_MIN_SAMPLES`):
  `search_truth_rate`, `policy_truth_rate`, `blunder_rate`. Hoy `Policy argmax hit = 100/335` **no es
  atribuible** (mezcla "buscador equivocado" y "política equivocada").
- **Modos declarados**: `search` (actual), `tie_break` (decide el argmax sólo si `|gap| ≤
  policyTieMargin`, reutilizando la evidencia `near_tie`), `reflex_k` (ejecuta el argmax y explora k;
  **otro sistema**, nunca por defecto, con guardas M-B-07).
- **M-B-14 · Precondición del estrechamiento**: no se habilita por interruptor sino por calidad medida
  del prior (`policy_truth_rate` por encima de un umbral declarado durante N plies etiquetados).
  Un humano estrecha porque su prior está entrenado; con 30 % de acierto, estrechar es ruido.
- **M-B-11/12/13 · A/B**: brazos A `search`, B `tie_break`, C staged/consolidado, D `reflex_k`, con las
  MISMAS semillas; se reporta victorias, llamadas Jev, ms, `ACTION ACCURACY` y contadores de juez; la
---

## 3. SPEC-01c · M-C-01 · Consolidación entre juegos (EN IMPLEMENTACIÓN)

### 3.1 Motivo

En `live` el rule set se reescribe **dentro** del juego: el que propone es el que aprueba (sin juez
independiente), cada aplicación dispara una **re-búsqueda** del ply, y un intento ganado con reglas
móviles obliga a re-verificar. Además la propuesta siguiente sólo se pide **tras una derrota**
(`pickLossEvidence`), así que un juego **ganado pero no creído** no enseña nada. En `collect` no se
registra **dónde** el rule set dudó: sólo se encolan casos sueltos (≤12, se envían los últimos 6).

### 3.2 Diseño

- **M-C-01** Modo `consolidate` en `PATH_LEARNING_MODES` + `<option>`. Se apoya en guardas existentes:
  `playTrialGame` pone `midgameCorrections = 0` para todo lo que no sea `live` y marca
  `measurementGame = true` ⇒ **el juego es una medición limpia por construcción**.
- **M-C-02** `Reflection` (0 llamadas): `{ ply, side_to_move, class, trigger_text, rules_version, V,
  confidence, oracle, cases, count }`. Ring `match.reflections` con `REFLECTION_CAP`.
- **M-C-03** Trigger **tipado**: `courseCorrectionTrigger` devuelve `{ class, text }` con
  `contradiction | coin_flip | no_belief`; se añaden `triggerText()`/`triggerClass()` y contadores por
  clase (arregla que la mezcla de triggers sólo viviera en el log).
- **M-C-04** `consolidation_brief` acotado: ≤ `CONSOLIDATION_MAX_REFLECTIONS` (6) reflexiones ×
  `CONSOLIDATION_CASES_PER_REFLECTION` (2) casos, con `by_class`, resumen de juegos, loss report si lo
  hay y `rules_under_test`. `atom_accuracy`/`dead_atoms`/`attempt_cost` no se duplican: los añade
  `buildMetaContext`.
- **M-C-05** Punto de consolidación: `consolidateReflections(attempt, score)` **una vez por intento**
  (`CONSOLIDATION_SCOPE = "attempt"`), tras `scoreRulesOverTrials`; su propuesta es el candidato del
  intento siguiente. Nunca se aplica dentro del juego que se está midiendo (I4 intacto). Sin
  reflexiones no hay consulta.
- **M-C-06** Contadores `reflectionsRecorded`, `consolidations`, `consolidationsApplied`,
  `consolidationsIdle`, `triggerClasses`; tiles `REFLECTIONS`, `CONSOLIDATIONS`, `TRIGGER MIX`.
- **M-C-07** Log greppable y deduplicado: `REFLECTION class=… at ply N (…)` (una vez por clase),
  `CONSOLIDATION after attempt N: k reflection(s) [contradiction a, coin-flip b, no_belief c] -> vM`,
  `CONSOLIDATION … NO CHANGE …`, `No consolidation after attempt N: …`.

### 3.3 Coste/beneficio medido (run del 2026-09-18)

| Efecto | Cálculo | Magnitud |
|---|---|---|
| Re-búsquedas intra-juego eliminadas | 26 correcciones / 5 juegos ≈ 5,4 por juego, cada una re-busca 1 ply de ~30 | ≈15-18 % de hojas por juego |
| Ida y vuelta de re-verificación | `verifyRulesCleanly` rejuega el intento completo si hubo cambios mid-game | hasta +100 % en el intento que gana |
| Consultas LLM | de 1 por trigger a ~1 por intento, con evidencia agregada | menos llamadas, mejor señal |
| Señal de aprendizaje | "gané pero no me lo creí" entra por diseño | nueva |

### 3.4 Guardas y decisiones

- **D-C1** El default de `pathLearning` **sigue siendo `live`** hasta el A/B (documentado).
- **D-C2** Alcance `attempt` (constante declarada, no perilla).
- **D-C3** La consolidación **convive** con `nextHypothesisRules`: consolidación si hay reflexiones,
  loss-report si no.
- **D-C4** `collect` se queda como "medir sin aprender" (y es lo que usa `verifyRulesCleanly`): **no**
  registra reflexiones, para que la re-verificación limpia no contamine la evidencia.

### 3.5 Trampa encontrada AL IMPLEMENTAR (queda documentada)

En `consolidate` los juegos del intento son **measurement games**, y `runCatsPly` recibe
`pathLearning: false` precisamente para que el escritor mid-game no actúe (3729/3904). La primera
versión de la consolidación registraba las dudas **detrás** de esa bandera, es decir: habría registrado
**cero** reflexiones en los juegos que importan y el boundary nunca habría tenido nada que consolidar.
Corrección: `recordingOnly` deja pasar el **oráculo** y el **registro** sin abrir la puerta a ninguna
mutación (en `consolidate` la consulta no se hace en el ply, así que medir y registrar son
compatibles). Es el tipo de fallo que sólo se ve ejecutando el bucle completo, y por eso el check 9 lo
bloquea: *un intento `consolidate` mantiene sus juegos limpios y aun así ejecuta el oráculo que
alimenta el journal* (medido: 2 juegos, 2 reflexiones, 1 consulta de boundary, 0 cambios mid-game).

### 3.6 Tests (selftest)

1. `consolidate` no cambia reglas dentro del juego y **sí** registra reflexión;
2. `collect` no registra reflexión (pureza de medición);
3. sin reflexiones no hay consulta (`llmCalls` no crece);
4. reflexiones contiguas de la misma clase se agrupan (`count`, y la mezcla de triggers las cuenta);
5. la consolidación aplica una propuesta con `task = 'consolidate_reflections'` (versión al alza);
6. prosa sola ⇒ `NO CHANGE` (versión intacta, contador idle);
7. el brief respeta los topes **por sí mismo** y no duplica `atom_accuracy`;
8. dos gates estáticos: trigger tipado + mezcla contada, y el modo `consolidate` presente en markup,
   modos, registro, punto de consolidación, payload **y prompt** (la tarea está documentada para el
   modelo, o el brief no se entendería);
9. el intento completo de §3.5 (regresión de la trampa de la bandera de medición).

---

## 4. Validación

- `node fox-hounds-harness.selftest.js`: **264 checks · 0 fallos · exit 0** (239 antes de M-C-01;
  +9 de M-C-01, +3 del audit de honestidad, +4 de M-B-02, +9 de SPEC-01).
- `node jev-relay.js --selftest`: **21 checks · 0 fallos**.
- CRLF preservado (0 líneas LF-solas en los tres ficheros) y temporales limpiados.

## 5. Decisión de implementación

Orden: **M-C-01 (consolidación · HECHO) → M-A-13 + audit del contrato (HECHO · §6) → M-B-02 (agregado de
política · HECHO) → SPEC-01 completo (HECHO · §1) → M-B-03/04 (verdad de acción / ACTION ACCURACY) →
A/B de modos (`live` vs `collect` vs `consolidate`) → `reflex_k` (experimental).**

## 6. Audit del prompt de System 2 (HECHO · 2026-09-18)

Se revisaron **todas** las afirmaciones que el prompt, el JSON shape, el schema doc y los briefs hacen
al modelo, contra el código. Resultado y qué se hizo:

| # | Hallazgo | Sev. | Estado |
|---|---|---|---|
| 1 | `LIMIT: a battery needs at least one VALUE question` **no estaba enforced**: una batería sólo-policy pasaba el gate, `normalizeWeights` caía al vector anterior y **V(s) quedaba constante en 0.5** sin un solo error | **ALTA (bug real)** | **ARREGLADO**: el gate refusa y conserva la batería anterior + warning + check de selftest |
| 2 | Rango del floor falso (`[0.5,0.95]` vs `[0.3,0.95]`) y "below this the harness re-asks you" (mecanismo retirado) | ALTA | **ARREGLADO**: rango renderizado desde la constante + descripción real (poda / evidencia de un trigger) |
| 3 | Log por respuesta: `LOW CONFIDENCE (… so System 2 will be asked to revise the rule set)` | ALTA | **ARREGLADO**: dice lo que hace (no puede cortar; cuenta como evidencia si un trigger dispara) |
| 4 | Log HALT: `Halting the deep search … System 2 is consulted once this ply completes`; `ctx.halted` **no lo lee nadie** | MEDIA | **ARREGLADO**: el log dice la verdad y el campo queda documentado como registro, no como señal |
| 5 | `If jev_prunes is 0 while leaves_below_floor is large …` atribuía todo a la confianza | MEDIA | **ARREGLADO**: se añade la segunda condición (`remaining > 0` tras el batch) y que la profundidad es la palanca |
| 6 | `the confidence below is … not a trigger the harness acts on` (contradice el trigger `no_belief`) | MEDIA | **ARREGLADO (texto)**; el campo `low_confidence_report` sigue siendo **siempre null** (ningún caller lo pasa) → candidato a retirar |
| 7 | Se describe **una** distribución de política, pero varias se fusionan por **máximo** por movimiento | MEDIA | **DOCUMENTADO** en el prompt; el arreglo de fondo es **M-B-02** |
| 8 | `One HTTP call per leaf board, of the order of 0.5 s` (medido: ≈3 s con `jev-1.13.0`) | BAJA | **ARREGLADO**: segundos, medido, y por qué importa (las hojas deciden si un intento termina) |
| 9 | `Policy Depth: 0 off, 1 root only, 2 root and its children` (la perilla llega a 3) | BAJA | **ARREGLADO** |
| 10 | "WHAT YOU RECEIVE BACK" omitía claves que el payload sí lleva | BAJA | **ARREGLADO**: se listan `board_digest`, `current_rules`, `measured_error`, `battery_in_use`, `question_role_policy`, `weight_zero_policy`, `path_learning`, `telemetry` |
| 11 | **El rango del floor estaba duplicado en el motor**: el gate aceptaba `[0.3,0.95]` y el prompt lo anunciaba, pero la búsqueda elevaba el valor con `clamp(x.confidenceFloor, 0.5, 0.95)` en **cuatro** sitios (contexto de búsqueda, selección de casos, ply de los gatos, informe de coste) | **ALTA** | **ARREGLADO**: los cuatro usan `CONFIDENCE_FLOOR_RANGE` (una sola fuente de verdad) + aserción de que no queda ningún `0.5, 0.95` hardcodeado |

**Consecuencia de la fila 11:** un floor que System 2 escriba por debajo de 0.5 ahora **se aplica de
verdad** (antes se elevaba en silencio), que es exactamente lo que la fila 2 del prompt promete. Efecto:
más poda a floors bajos (más barato, menos fiable) y ningún cambio para los rule sets guardados con
floor ≥ 0.5. **Sigue pendiente (F1 en el plan de UI):** el campo *Confidence Floor* del header sólo
siembra el rule set neutro; el rule set guardado manda, tal como el prompt ahora dice explícitamente.

**Verificado y correcto** (no se tocó): `plies_to_end` es la clave real del informe de verdad;
`dead_atoms`/`atom_stats` usan las constantes interpoladas; `attempt_cost` coincide campo a campo;
`explores EVERY legal move: the prior reorders, it never cuts` era verdad; la omisión de preguntas
`subject: "cats"` con el ratón en juego está implementada y logueada.

**Guardas añadidas:** gate estático `the System-2 contract never advertises a capability the engine does
not have` (0 apariciones de `narrows` en el fichero + textos honestos presentes + frases retiradas
ausentes) y push de comportamiento sobre `buildLlmSystemPrompt()` (el texto real que recibe el modelo:
sin `narrow`, con el contrato de política y con el rango del floor impreso desde la constante).

---

## 7. Alcance de SPEC-01, y por qué SPEC-02 es su extensión natural

**SPEC-01 es una prueba básica, acotada a un espacio de estados que se conoce de antemano.** El tablero,
las piezas, las reglas y el oponente son fijos, así que **todas las mutaciones posibles viven dentro de un
conjunto cerrado de estados** y **el estado final es computable**: contra el ratón determinista la posición
se resuelve (`solveAgainstGreedy`) y el harness tiene un **oráculo**. De esa premisa salen sus tres pilares:

1. el aprendizaje se mide contra la **verdad calculada**, no contra una opinión: de ahí `CONTRADICTION`,
   `atom_accuracy` y el etiquetado de cada revisión (`against_truth`);
2. el juez más fuerte es la **medición** (contradicción con las reglas y replay de la decidibilidad sobre
   las líneas que dispararon la consulta), y el consenso sólo existe para los huecos que la medición deja;
3. cada cambio se juzga por su efecto sobre **líneas concretas ya pagadas**, no por su plausibilidad.

Es, por tanto, **una solución concreta y útil para un sistema de exploración por autodescubrimiento y
mejora de reglas sobre un espacio de estados conocido y finito**. Y conviene decir qué implica eso:

**El límite explícito.** Todo lo anterior se apoya en poder calcular el estado final. Si el espacio **no se
asume finito** y **pueden aparecer elementos nuevos** —entidades, reglas, acciones que no existían al
diseñar el sistema—, entonces:

- **minimax no es aplicable**: no hay horizonte computable, luego no hay árbol que recorrer;
- **el oráculo desaparece**, y con él el juez de nivel J1, las etiquetas de verdad y la medida de precisión
  por pregunta: sin verdad no hay "hacia/contra la verdad";
- el criterio de aceptación deja de ser "gana **todos** los juegos de este conjunto cerrado" y pasa a ser
  **estadístico sobre episodios** (tasas, intervalos, no una garantía);
- y la única moneda honesta es una **distribución de probabilidad sobre las acciones**, condicionada a la
  observación que se puede estimar en ese momento y a las reglas que se conocen.

Ése es exactamente el escenario para el que **SPEC-02 es la arquitectura correcta**: `tie_break` como paso
intermedio (el prior decide sólo donde el valor no distingue) y `reflex_k` como ejecutor de política, con
`ACTION ACCURACY` sustituida por consistencia y resultado observado, y con **M-B-14** como precondición:
sólo se estrecha el ancho cuando la política demuestra calidad medida, porque un prior sin entrenar que
acierta el 30 % de las veces no es pericia, es ruido.

**Qué se conserva al cruzar ese límite** (por eso la continuidad es posible): el artefacto de aprendizaje
sigue siendo un conjunto de reglas **evaluables** (I1), el harness sigue sin inventar valores (I2), y el
juez final sigue siendo **el mundo** —episodios— y no la opinión del modelo. **Qué hay que sustituir**:
oráculo → evaluador de acciones por episodio; contradicción con la verdad → **ganancia de información**
(curiosidad) como criterio de selección de evidencia; aceptación determinista → aceptación estadística; y
un estado que admita **entidades nuevas**, no sólo `{cats, mouse, turn, ply}`.

**En una frase:** SPEC-01 responde "¿puedo mejorar las reglas con las que juzgo un mundo que puedo
resolver?" y SPEC-02 responde "¿qué hago cuando no puedo resolver el mundo, pero puedo actuar en él?".
Este harness implementa hoy la primera, y deja la segunda especificada con sus precondiciones.

---

## 8. M-D · El modelo del ratón, su currículum y la evidencia obligatoria (IMPLEMENTADO 18/09/2026)

**Motivo (ver `INFORME.md` §8):** con el criterio "ganar todos los juegos" contra un ratón `greedy`
fijo, el espacio de medición real es **≤4 columnas** (`config.seed` no entra en juego: los seeds del
trial matrix son decorativos). El primer intento que gana terminaba la búsqueda ⇒ 1 sola llamada de
generación y nada aprendible: la vara era una pared, no un gradiente. La decisión de diseño es del
operador: **obligar a System 2 a generar diversidad no cambiando el criterio, sino subiendo la vara.**

**Los tres sitios que antes discrepaban y ahora son UN concepto:** quién juega el ratón
(`runMouseTurn`), la única réplica que el search de los gatos predice (`predictedMouseMove` dentro
del minimax) y la verdad con la que el oráculo etiqueta (`solveAgainstModel`). Antes: juego greedy,
search greedy, **solver de juego PERFECTO etiquetado como "contra el greedy"** (todos los
CONTRADICTION labels eran sobre un juego más difícil que el jugado) y, en partidas humanas, a Jev se
le seguía describiendo el planificador fijo.

| ID | Entregable | Dónde vive |
|---|---|---|
| M-D-01 | **Modelo del ratón de primera clase** (`mouseModelDepth`/`opponentModelId`/`opponentDescription`): la descripción que viaja en el estado a Jev es la del modelo ACTUAL (en partida humana dice `human` y pide el peor caso) | `toWireState`, `buildLossEvidence.mouse_policy` |
| M-D-02 | **Planner code-only** (`solveLookahead`/`planMouseMove`): búsqueda de prueba acotada (`PLAN_NODE_BUDGET`) que prefiere victoria probada (la más rápida) > horizonte indeciso > tablas > derrota probada (la más larga). **Nunca lee el rule set bajo test ni llama a Jev** ⇒ su fuerza es monótona en `mouseDepth` e independiente del evaluador. Memo `(estado, ply, profundidad)` con contadores de agotamiento | `PLAN_PREFERENCE`, `mousePlanCache` |
| M-D-03 | **Currículum** (`escalateMouseNow`): victoria limpia ⇒ el ratón planifica un ply más; **los gatos NUNCA suben de profundidad** (invariante `mouse ≥ cats`). Knobs: *Escalate the Mouse*, *Mouse Depth Max*, *Escalate After*, *Max Escalations*. Techo honesto: si nada gana tras escalar se conserva el incumbente con `Curriculum ceiling: the limiter is the EVALUATOR` | `runLearning` (`mouseDepth/escalations/consecutiveWins/incumbent` en `match.tuning`) |
| M-D-04 | **Una escalada es un mundo nuevo** (`resetMeasurementWorld`): se limpian `mousePlanCache`, `oracleCache`, `jevAnswerCache` y `jevBeliefBaseline`; y las claves de caché llevan el modelo (`inferenceKey … '|o' + opponentModelId()`, `oracleCache … '|m' + depth`) ⇒ ninguna respuesta del ratón débil sobrevive a la escalada | `resetMeasurementWorld` |
| M-D-05 | **Prompt desanclado**: el *Required JSON shape* muestra placeholders (`renderRulesShape(null, true)`) — un molde con los ids escritos es una respuesta — y V(s) se describe sobre "las preguntas de VALOR que TÚ declaras" | `RULES_JSON_SHAPE`, `buildLlmSystemPrompt` |
| M-D-06 | **Evidencia obligatoria (gate J0)**: con `path_brief`/`consolidation_brief`/`loss_report` la propuesta debe citar `evidence_ref` (índice de caso o verdad etiquetada, o `state_key`); si no cita evidencia real ⇒ `UNSUPPORTED` (contado y logueado). El payload lleva `tried_rule_sets` (todo lo ya medido) y `mouse_model` (la vara actual, para que el autor sepa que ganar nunca es "terminar") | `validateEvidenceRef`, `summarizeTriedRuleSets`, `buildMetaContext` |
| M-D-07 | **Contabilidad honesta**: tiles `Mouse depth (cats/mouse)`, `Escalations`, `Mouse planner`, `V(s) vs truth (MAE)`, `Unsupported proposals`; `Trigger mix` cuenta también en `live`; **MAE de V(s) contra el oráculo ya pagado** (0 llamadas nuevas, `noteValueAgainstTruth`); botón **`Copy Run Journal JSON`** (historial de sets con from→to, jueces, revisiones, currículum, telemetría); procedencia de la aceptación (`match.acceptedAt`) visible en el log de copiado y en el journal | `STAT_TILE_DEFS`, `buildRunJournal`, `acceptRules` |
| M-D-08 | **Honestidad de mensajes**: el aviso de "sin poda" ya no recomienda bajar el floor (un lote que cubre todas las ramas deja imposible el corte en ese nodo: la palanca es la profundidad); el `narrow` con replay SILENTE se reporta como silencio, no como medición; el `CLEAN RE-VERIFICATION PASSED` dice que el set PRE-corrección es el artefacto | `runLearning`, `judgeRuleDiffMeasured` |
| M-D-09 | **Bug latente arreglado**: `describeTruthGap` interpolaba `truth.plies` pero las filas de `annotateTruth` traen `plies_to_end` (el oráculo nuevo expuso la rama "THE VALUE WAS RIGHT" y un "undefined plies to the end" llegó hasta el payload) | `describeTruthGap` |

**Qué NO cambió:** el criterio de aceptación ("ganar todos los juegos del intento"), el
re-verification limpia (`verifyRulesCleanly`, I4), los jueces J1/J2/J3, la política de agregado
(M-B-02) y la doctrina "sin Jev no hay valor" (I2).

**Coste declarado:** el planner es code-only (0 llamadas Jev) y acotado por presupuesto; lo que
crece con el currículum es el **número de intentos** (escaladas × K juegos), no las hojas por juego.
Cada escalada además re-paga las respuestas de Jev del nuevo mundo (los cachés del ratón débil se
descartan a propósito: son respuestas de otro juego).

---

## 9. F1–F6 · Post-run del 19/09 + intervención del operador (IMPLEMENTADO 19/09/2026)

**Motivo:** el run de 7/19 enseñó seis cosas (ver `INFORME.md` §3): la clave del oráculo y la del
journal de revisiones **no coincidían** (las 1424 revisiones quedaban `0 vs truth`); el `narrow`
podía **plantar pesos fantasma** (átomos de una batería que ya no existe ⇒ 0.5 neutral en cada
hoja); el memo del planner (1,4M de accesos) vivía en un Map **sin tope propio**; un `narrow` con
versión repetida podía mover la historia **hacia atrás**; System 2 **renombraba** preguntas en vez
de evolucionarlas (reiniciando sus estadísticas); y el operador no tenía forma de **sacar al
aprendizaje de un mínimo local** mid-run.

| ID | Corrección | Dónde vive |
|---|---|---|
| F1 | **Clave única del oráculo** `oracleCacheKey(state)` = `stateKey + ply + modelo del ratón`: `oracleVerdict` y `recordRevision` usan la **misma** clave ⇒ las revisiones vuelven a etiquetarse contra la verdad. En tu próximo run verás `Revisions N (K vs truth)` con **K > 0** | `oracleCacheKey`, `oracleVerdict`, `recordRevision` |
| F2 | **`narrowRuleSet` re-asienta los pesos sobre la batería conservada**: átomos fantasma ⇒ **se sueltan, se reportan y se renormaliza** (`normalizeWeights`/`normalizePolicyWeights` sobre los átomos declarados). Un fantasma antes fresco es ruido 0.5/hoja que contamina los replays que juzgan los diffs | `narrowRuleSet` |
| F3 | **`cacheSet` + `MOUSE_PLAN_CACHE_LIMIT = 40000`**: el memo del planner tiene tope propio con **evicción FIFO** (el límite genérico de 6000 se lo tragaba el planner y expulsaba el 99,6 %) | `cacheSet`, `mousePlanCache` |
| F4 | **Versión del `narrow` = `highestKnownVersion(previous) + 1`**: el ledger del run manda, no el número que el modelo repita | `narrowRuleSet`, `highestKnownVersion` |
| F5 | **Línea del prompt: evolucionar > renombrar** (`RENAMING IS NOT EVOLUTION`): renombrar reinicia las estadísticas medidas de la pregunta | `buildLlmSystemPrompt` |
| F6 | **Intervención del operador: `cfg-operator-directive` + botón "Force System-2 consult"** (ver §9.1) | `queueOperatorIntervention`, `directiveRules`, `takeOperatorIntervention` |

### 9.1 Salir de un mínimo local con una directiva

**Diseño:** el texto (≤500 caracteres) se encola con `queueOperatorIntervention()` y se consume en
el **siguiente borde de intento**, nunca dentro de un juego (los juegos siguen siendo mediciones
limpias). La consulta lleva la directiva **más** la evidencia que el intento produjo (`lossReport`
si lo hay), con `task: 'operator_directive'`, y su salida recorre las puertas normales
(`validateEvidenceRef` con cita `evidence_ref: { operator_directive: true, … }`, gate de cambio
evaluable, floor del ledger). **Incluyendo la aceptación**: si el intento ganó todos los juegos,
la directiva se consume primero y el set directivo es lo que mide el intento siguiente — porque
"acaba de ganar" es exactamente el mínimo local del que el operador quiere escapar. Una propuesta
que **no reconoce la directiva** es `UNSUPPORTED` (contada); un `NO CHANGE` honesto devuelve al
borde normal. Sin System 2 disponible, error y borde normal.

**Uso:** durante el run (p. ej. al ver el trigger mix 0/112/1 con la misma tríada de movimientos
repetida), escribe *"Cats advance in formation, keeping one horizontal line while far from the
Mouse — value that, or make it a policy question"* en el campo y pulsa
**Force System-2 consult**. El log marca `OPERATOR INTERVENTION queued … consumed at the end of
the current attempt`, y la siguiente medición juzga el set directivo como cualquier candidato.

**Guardas:** el tile `Operator interventions` lo cuenta; el journal exporta
`operator_interventions`; el selftest verifica la superficie (campo + botón + funciones +
`tarea/payload/cita/procedencia`), el caso feliz con floor del ledger (propuesta v3 con el
ledger en v8 ⇒ **v9**), el rechazo `UNSUPPORTED` de una propuesta que ignora la directiva, y
factos de formación post-juego (`catFormationFacts`: spread / `left_behind` **medidos**, no
juzgados, listos como evidencia futura).

---

## 10. M-B-05 · La lectura del tablero es obligatoria (IMPLEMENTADO 19/09/2026)

**Motivo:** el operador observó que System 2 debía hacer **cálculo mental sobre coordenadas**
(dispersión horizontal, líneas rotas, rutas del ratón) para proponer una corrección — exactamente
lo que los LLM hacen mal — y que el prompt ni siquiera lo invitaba a formular ese cálculo
explícitamente. La consecuencia medible del run 7/19: tríadas de preguntas que sólo se **re-pesan**
en números, nunca se **re-fundan** desde una lectura del tablero.

**El contrato nuevo:** antes de proponer un cambio del rule set, System 2 devuelve un campo
`board_reading` junto a `evidence_ref`:

```json
"board_reading": {
  "positions": [<case | reflection_index | state_key que el harness le mostró>],
  "measures": [{ "name": "horizontal_spread",
                 "definition": "max(cat row) minus min(cat row) over the four Cats",
                 "values": { "<case>": <número finito> } }],
  "distinction": "la línea ganadora mantiene spread ≤1; la perdedora abre a 3"
}
```

| Guarda | Dónde vive | Qué garantiza |
|---|---|---|
| **Gate estructural** `validateBoardReading` | junto a `validateEvidenceRef` (J0) | Todo lo que el autor dice haber medido es **trazable**: cada posición existe en el brief/loss report recibido; cada medida tiene nombre + **definición reproducible** + números finitos. Sin lectura, o con lectura que no nombra nada mostrado ⇒ `UNSUPPORTED` (contado en `unsupportedProposals`). Arregla el fallo de diseño: el cálculo mental sin trabajo mostrado |
| **NO verificación aritmética** (decisión de diseño) | comentario del gate | El harness **no** replica la aritmética del modelo: no quiere centralizar el cálculo ni confiar números no verificados dentro de V(s) (I2). El gate responde *"¿mostró su trabajo?"*, nunca *"¿es correcto?"* |
| **Separación como evidencia** `readingSeparatesCases` | payload del juez J3, **cegado** como el resto | El juez ve qué se midió y si los propios números **separan** los casos (`board_reading_separates: true/false/null`). Valores iguales en ambos lados = evidencia **en contra** del diff. Nulo = silencio, no veredicto |
| **I1 intacto** | aserción del selftest | La lectura es **evidencia de autoría** (gateada, juzgada, archivada en la mutación), **nunca** parte del rule set ni entra en `composeLeafValue`/`normalizeWeights` — el artefacto de aprendizaje sigue siendo sólo lo que Jev evalúa |
| **Briefs con la orden** `read_the_board_first` | `buildPathBrief`, `buildConsolidationBrief` | La instrucción viaja en la propia evidencia: *"rellena `board_reading` antes de reescribir nada; la distinción que reclamas debe verse en TUS números"* |
| **NO CHANGE exento** | `mutateRulesWithLLM` | *"Nada que cambiar"* no necesita lectura: la exención evita castigar la respuesta honesta |

**Tests de esta fase (integrados en el selftest):** lectura bien formada pasa y separa · sin lectura ⇒ rechazada
· una sola posición pasa el gate pero **no separa** (el juez necesita dos valores: esa regla vive en la
separación, no en el gate — una reflexión del boundary suele llevar UNA posición y exigirle dos haría
la consulta imposible de satisfacer) · posiciones que nadie mostró ⇒ rechazadas · valores iguales ⇒
no separa (evidencia en contra) · y la aserción I1 de que la lectura no entra en la composición.

---

## 11. Fórmula ejecutable de observación y juicio (IMPLEMENTADO 21/09/2026)

La lectura manual de autor de §10 queda reemplazada como mecanismo de evidencia: System 2 recibe los
estados estructurados y declara fórmulas, pero no proporciona valores calculados por él. El artefacto
que aprende el experimento es explícitamente una fórmula:

`formula = { O(s), r_i, w_i }` y `Environment.Eval(formula) = Σ_i w_i · Jev(r_i(O(s)))`.

- **System 2 declara `O(s)`** en `observations`. Puede seleccionar un primitivo puro (`kind: "op"`)
  o formular una expresión segura (`kind: "expr"`) con rango explícito. El AST admite agregados
  `count|min|max|sum|mean|spread` sobre `cats|mouse|all`, aritmética, `abs`, `neg`, `clamp` y llamadas
  a primitivos registrados. No se ejecuta JavaScript arbitrario.
- **El harness calcula** cada medida sobre `boardPositionArray(state)`, un array plano e inmutable de
  `{piece,index,x,y}`. `computeObservations` produce el vector `O(s)` y nunca llama a la red.
- **Las hojas son la evidencia de System 2**: cada caso conserva `position_array`, el `O(s)` vigente,
  los átomos de Jev, el camino que llevó a la hoja y una etiqueta `good_for_cats|bad_for_cats|neutral`
  cuando el solver puede decidirla. Las hojas encoladas tampoco pierden el tablero estructurado.
- **La fórmula candidata se reprocesa en código**: `replayFormulaOnEvidence` ejecuta las observaciones
  propuestas sobre exactamente las hojas que motivaron el cambio. Si falta un tablero o una medida no
  produce un número finito, el candidato se rechaza antes de pedir a Jev que lo juzgue.
- **Jev conserva el juicio**: las preguntas de valor reciben el vector medido, no las coordenadas del
  tablero, y producen los átomos `r_i`. Una pregunta de política es sólo un prior opcional de ordenación
  de movimientos concretos: no aprende la calidad de las hojas ni sustituye su evaluación.
- **Código conserva la composición universal**: `composeLeafValue` es el único sitio que calcula
  `Σ w_i·r_i`; pesos normalizados, resultado en `[0,1]`.
- **El entorno tiene `Eval(formula)`**: `createBoardEnvironment(state).Eval(ruleFormulaOf(rules))`
  compila/cachea la fórmula, calcula observaciones, obtiene juicios live o cacheados y devuelve
  `formulaHash`, `judgmentFormulaHash`, medidas, átomos y valor.
- **Cachés correctas**: la identidad semántica incluye las especificaciones de observación. Cambiar
  una medida invalida tanto la caché exacta como la vectorial aunque el número casualmente coincida.
  Dos tableros sólo comparten juicio por vector cuando Jev vio exactamente `O(s)`; nunca cuando vio
  coordenadas completas o una política.
- **Gate transaccional**: omitir `observations` conserva las del incumbente; `{}` se rechaza porque una
  fórmula ejecutable debe observar al menos un hecho. Si los placeholders dejan la batería sin regla de valor, se restaura batería + observaciones
  previas en lugar de crear silenciosamente `V(s)=0.5`.

También se corrigieron los fallos encontrados en la implementación parcial: regex de placeholders
con espacios/ids que contienen `s`, hashes que ignoraban observaciones, dos `ReferenceError` en el
diff de observaciones, serialización mezclada de preguntas/observaciones y cachés no limpiadas al
cambiar el mundo de medición.

## 12. Fan-out paralelo de jugadas de gato (IMPLEMENTADO 21/09/2026)

- En **aprendizaje**, el nodo raíz de cada pasada usa el ancho legal completo de los gatos y `minimax`
  ejecuta esos estados mediante un único `Promise.all`. Los niveles internos mantienen `parallelBranch`.
- Este perfil es exhaustivo a propósito: cada hoja juzgada por Jev es evidencia para descubrir el rule set;
  no se descartan ejemplos positivos o negativos para acelerar una decisión concreta.
- `parallelLeaves` es el límite duro de llamadas Jev vivas; por defecto vale 8 y el usuario puede
  reducirlo desde Advanced si el endpoint impone un límite menor.
- La telemetría registra pasadas/ramas de fan-out y el pico observado de llamadas Jev concurrentes.

## 13. Alfa-beta paralelo para PLAY humano (IMPLEMENTADO 21/09/2026)

- `createSearchContext` selecciona `play-pv-alpha-beta` sólo cuando el humano juega el ratón y, por
  tanto, el árbol debe tratar sus respuestas como adversariales. Aprendizaje sigue en
  `learning-fanout` y el ratón code-only conserva exactamente su semántica.
- Cada nodo resuelve primero un hijo principal y actualiza su ventana antes de lanzar hermanos. Los
  restantes se procesan en lotes especulativos de dos: conserva paralelismo Jev, pero deja trabajo aún
  no iniciado que un cierre `alpha >= beta` puede omitir.
- La poda no usa `confidenceFloor`. Alfa-beta es exacto respecto al escalar congelado `Eval(R,s)`;
  confianza baja es evidencia para System 2, no un intervalo matemático. Toda hoja no terminal que se
  evalúa sigue siendo `Environment.Eval(formula) -> Jev -> Σ w_i·rule_i`.
- La tabla de transposiciones guarda `EXACT`, `LOWER` o `UPPER`. Una cota estrecha la ventana y sólo se
  devuelve directamente cuando la cierra; nunca se reutiliza como valor exacto.
- La prueba de equivalencia ejecuta el mismo árbol adversarial con confianza `0.1`: el perfil exhaustivo
  visita 229 hojas y no poda; PLAY devuelve la misma jugada y `V(s)` visitando 67 hojas, con 24 cortes.
  Es una medida sobre el stub determinista, no una promesa de latencia del endpoint real.
