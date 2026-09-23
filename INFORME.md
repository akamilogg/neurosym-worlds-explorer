# INFORME · El Gato y el Ratón · Exploratory Harness

**Fecha:** 19/09/2026 · **Ámbito:** `fox-hounds-harness.html` (+`fox-hounds-harness.selftest.js`)
**Documento hermano:** `SPEC-APRENDIZAJE-DIFFS-Y-ACCIONES.md` (especificación de lo que está por venir)

---

## 1. Qué es el sistema y cuál es su criterio

Harness **neuro-simbólico** de dos sistemas, y la división es deliberada:

| Rol | Quién | Qué decide |
|---|---|---|
| **System 1** | **Jev** (TypeSafe `/v1/systemone`) | **Todo juicio sobre la posición**: responde una *batería de preguntas* tipadas (choice / score / noul) y, si se declara, una distribución sobre los movimientos legales (rol `policy`) |
| **System 2** | LLM (chat-completions) | **Sólo escribe reglas evaluables**: instrucciones, criterios (rúbrica), tipo/rol, pesos, `policyWeights`, `aggregate` y el *confidence floor* |
| Código | el harness | Compone `V(s)` desde las respuestas tipadas, genera los movimientos legales, decide los finales y busca con minimax; **no inventa valores ni opiniones sobre jugadas** |

**Criterio de aceptación (intacto):** un rule set se acepta **sólo si los gatos ganan todos** los juegos
del intento, y si hubo revisiones dentro de los juegos se **re-verifica limpio** (`verifyRulesCleanly`).
**Artefacto de aprendizaje:** siempre un rule set evaluable; la prosa (`rationale`) **no** se evalúa, y
responder sólo con prosa cuenta como `NO CHANGE`.

---

## 2. Diagnóstico del run medido

Cifras tomadas de la telemetría de un run real (un intento en curso, `jev-1.13.0`):

| Métrica | Valor | Lectura |
|---|---|---|
| Llamadas Jev vivas / reuso | 13 943 / 2 803 | 2,97 s de media (p95 3,00) ⇒ **≈11,5 h de Jev**; concurrencia efectiva ≈5,8/6 ⇒ **≈2 h de reloj por 2 intentos** (≈23 min/juego, ≈68 min/intento) |
| Nodos / hojas | 27 223 / 16 374 | ≈3 275 hojas por juego: **árbol completo** |
| Transposiciones | 1 080 (4 % de los nodos) | En árboles profundos la memoria no ayuda |
| **Cortes alpha-beta** | **0** | Ni un corte, ni los "certain" de las reglas |
| Confianza media de Jev | **0,365** (15 833 hojas por debajo de 0,45) | El gate de poda estaba inerte: 96,7 % de las hojas no pueden cortar |
| Resultado | **3/5 victorias**; mejor intento 2/3 | Con "ganar todos" y p≈0,6: P(3/3)≈21,6 %/intento ⇒ ≈94 % en 12 intentos, **a ese coste** |
| Consultas mid-game | 27, **26 aplicadas** | Presupuesto saturado: el disparador dominante era *coin-flip* / "no me creo mi jugada" |
| Prior de política | 67 llamadas · argmax coincide **100/335 (30 %)** | Ordenaba, no decidía; y se fusionaba por **máximo** (ni media ni voto) |

### 2.1 Las dos causas de "0 cortes" (ambas verificadas en código)

1. **La perilla del floor no llegaba al gate.** El campo del header decía 0,45 mientras el log imprimía
   *"below the 0.5 floor"*: la búsqueda elevaba el valor con `clamp(x.confidenceFloor, 0.5, 0.95)` en
   **cuatro** sitios, y el prompt anunciaba `[0.5,0.95]` mientras el gate aceptaba `[0.3,0.95]`.
2. **Geometría del batch.** Un corte exige `remaining > 0` **además** de `confidence >= floor`, y el
   `parallelBatch` por defecto es 6: los nodos del ratón tienen **1** hijo y la mayoría de los de gatos
   tienen ≤6 movimientos ⇒ **estructuralmente no hay nada que cortar**. La palanca de coste es la
   **profundidad**, no el floor.

---

## 3. Run del 18/09 + correcciones del 19/09 (F1–F6)

### 3.1 Lo que enseñó el run de 7/19 (seis hallazgos, todos verificados en código)

Cifras del run (con M-D ya en marcha, `jev-1.13.0`, mouse 3/3): **7 intentos · 19 juegos · 7/19
victorias de los gatos** (cada intento pierde, pero el sistema itera); **70 llamadas System 2** (0
errores); **35/57 correcciones** aplicadas; **1424 revisiones, 0 vs truth**; jueces 6/11/29;
**11 propuestas UNSUPPORTED** (el gate J0 funciona: creatividad sin evidencia ⇒ no es hipótesis);
**consolidaciones 0/0** (el run usaba modo `live`); **trigger mix 0/112/1** (puro coin-flip en un
modelo que jugaba la misma tríada de movimientos); `Neutral atom fallbacks` **2277**; MAE de
V(s) **0,3734**.

| # | Hallazgo | Causa verificada |
|---|---|---|
| F1 | Las 1424 revisiones quedan **`0 vs truth`** | `oracleVerdict` guardaba bajo clave con modelo (`'…|m3'`) pero `recordRevision` leía bajo clave sin modelo ⇒ el journal **nunca** encontraba la etiqueta. La evidencia más barata del sistema (verdad ya pagada) se desperdiciaba |
| F2 | El `narrow` puede **plantar pesos fantasma** | `narrowRuleSet` copiaba el vector del candidato sobre la batería conservada; un átomo de una batería que ya no existe compone como **0.5 neutral en cada hoja** (contado en `Neutral atom fallbacks`: 2277) y contamina los replays que juzgan los diffs |
| F3 | El memo del planner (**1,4M de accesos**) vivía sin tope propio | El límite genérico de 6000 lo compartía con las respuestas Jev: el planner expulsaba el 99,6 % antes de reusarlo |
| F4 | La historia de versiones podía ir **hacia atrás** | Un `narrow` cuya versión repetía un número bajo la movía atrás en el ledger (el historial exportado rebotaba v8→v3→v2) |
| F5 | System 2 **renombra** preguntas en vez de evolucionarlas | Renombrar reinicia las estadísticas medidas (`atom_accuracy`, witness) de la pregunta: el sistema olvida lo que ya sabía de ella |
| F6 | Sin salida de un **mínimo local** | Trigger mix 0/112/1 + la misma tríada de movimientos + las tríadas *blockade_integrity / escape_route_count / forced_trap_tempo* evolucionando sólo en **números**: el bucle afina, no salta. El operador lo ve antes que cualquier tile ⇒ necesita un botón, no una métrica más |

### 3.2 Las seis correcciones (implementadas y con guardas)

### F1–F3 (sesiones anteriores, ya validadas)
- **Modelo del oponente real**: contra el ratón determinista su nodo tiene **un** hijo (`chooseGreedyMouseMove`);
  sólo un ratón humano se modela como peor caso. Medición: depth 3 = 58 nodos/25 hojas vs 108/50 del modelo
  fantasma; depth 5 = 238/68 vs 1 238/408 (**−83 %**).
- **Floor alineado al vendor** (`CONFIDENCE_FLOOR_RANGE` con min 0,3, default 0,45).
- **El oráculo como disparador**: `oracleVerdict()` cacheado, `describeValueAgainstTruth()` (CONTRADICTION en
  ambas direcciones) y orden de disparo contradicción → jugada no creída → cara-o-cruz; el presupuesto cuenta
  **consultas**.
- **Precisión por pregunta** (`atom_accuracy`): media de cada pregunta en posiciones que las reglas **ganan**
  vs **pierden**, más la separación; `informative` es un juicio medido, no una impresión.
- **Log deduplicado** (`logNoteOnce`): una nota distinta se imprime una vez y luego se cuenta.

### F5 (esta sesión)

1. **Consolidación entre juegos (M-C-01, modo `consolidate`)** — el aprendizaje se mueve al **borde del
   intento**: durante los juegos sólo se **registran** las dudas (`REFLECTION class=contradiction|coin_flip|
   no_belief`, 0 llamadas) y en el boundary se consulta **una vez** con evidencia agregada. Consecuencias:
   el juego es **medición limpia por construcción** (desaparece la ida y vuelta de `verifyRulesCleanly`),
   no se reescribe el rule set "a ciegas" dentro de la acción, se ahorran las re-búsquedas por corrección
   (≈15-18 % de hojas por juego) y —lo más importante— **entra la señal que se perdía**: los juegos
   **ganados pero no creídos**, porque antes la propuesta siguiente sólo se pedía **tras una derrota**.
   *Trampa encontrada al implementarlo (documentada en la SPEC):* en este modo los juegos son *measurement
   games*, así que el registro tenía que sobrevivir a la bandera que frena al escritor mid-game; hay un test
   end-to-end que lo bloquea.

2. **Auditoría del contrato con System 2** (11 hallazgos, todos resueltos y con guardas):
   - **[BUG REAL, severidad alta]** el prompt prometía *"a battery needs at least one VALUE question"* y el
     gate **no lo comprobaba**: una batería sólo-policy pasaba, los pesos caían al vector anterior y
     **V(s) quedaba constante en 0,5 sin un solo error**. Ahora el gate la **rechaza** y conserva la batería
     anterior.
   - Tres **promesas falsas** corregidas: el rango del floor + *"below this the harness re-asks you"*; el log
     por respuesta (*"System 2 will be asked to revise"*, mecanismo retirado); y el log HALT (*"Halting the
     deep search"*, cuando `ctx.halted` no lo lee nadie).
   - Dos **claims causales incompletos**: el coste de la poda (ver §2.1.2) y el merge de política.
   - Cosméticos: latencia real (segundos, no "0.5 s"), `Policy Depth … 3`, y la lista completa de claves del
     payload.
   - **Unificación del floor** en una sola fuente: un floor por debajo de 0,5 que System 2 escriba **ahora se
     aplica** (antes se elevaba en silencio).
   - **Campo muerto retirado**: `low_confidence_report` no podía rellenarlo nadie.

3. **Aggregado de política (M-B-02)** — el `Math.max` por movimiento **ya no existe**. Cada pregunta de
   política declara `aggregate: "single" | "weighted_mean"`, y el rule set lleva **`policyWeights`** separado
   de `weights` (separado a propósito: un id de política en `weights` se contaría como 0,5 neutral en cada
   hoja). La fusión es una función pura `mergePolicyDistributions`: `single` = decide la primera declarada y
   las demás se reportan; `weighted_mean` = media ponderada de las distribuciones normalizadas. Ambos campos
   son **evaluables** ⇒ cambiarlos cuenta como aprendizaje.

4. **SPEC-01 completo: la propuesta se juzga antes de aplicarse**
   - **Journal de revisiones (0 llamadas)**: lo que el harness creía de un estado y cómo esa creencia se
     movió, con el Δ por pregunta y la etiqueta de verdad **gratis** cuando el oráculo ya había resuelto ese
     estado (`against_truth: true|false|null`; sin veredicto se declara `null`, nunca se asume).
   - **Jerarquía de jueces**: **J1** contradicción con las reglas (medición) → **J2** replay estrictamente más
     decisivo sobre las líneas que dispararon la consulta (medición) → **J3** consenso (3 votos, quórum 2,
     presupuesto propio, **rationale oculta**: el juez ve el cambio y la evidencia, nunca la historia del
     autor) → **J4** los juegos + re-verificación limpia (sin cambios).
   - **Veredicto `narrow`**: si el replay no puede medir el diff completo, se aplican **sólo** los campos
     medibles (`weights`, `policy_weights`, `confidence_floor`) y el resto se encola para el intento
     siguiente. Un juez no puede forzar un campo que el replay no puede comprobar.
   - Contadores (`Judges (a/r/n)`, `Revisions`) y logs greppables (`JUDGE …`, `REVISION JOURNAL at ply …`).
   - **Nota de alcance (SPEC §7)**: SPEC-01 es una prueba **básica y acotada** a un conjunto de estados
     **cerrado y conocido de antemano**, donde el estado final es **computable** (de ahí el oráculo y la
     verdad como juez); para un espacio **no finito con elementos nuevos** minimax no aplica y la moneda
     honesta pasa a ser una **distribución sobre acciones** (SPEC-02, con `M-B-14` como precondición del
     estrechamiento).

### 3.3 F1–F6 (19/09, tras el run de 7/19)

1. **F1 · clave única del oráculo** (`oracleCacheKey` = `stateKey|ply|modelo`): `oracleVerdict` y
   `recordRevision` usan la **misma** clave ⇒ las revisiones vuelven a etiquetarse contra la verdad
   ya pagada. En el próximo run: `Revisions N (K vs truth)` con **K > 0**; el `Trigger mix`
   debería moverse de puro coin-flip hacia `contradiction`.
2. **F2 · `narrow` sin fantasmas**: los pesos se re-asientan sobre los átomos de la batería
   **conservada** (recorte + aviso + renormalización a suma 1, igual para `policyWeights`); sin
   nada que conservar se mantienen los previos. Un fantasma es ruido que contamina los replays.
3. **F3 · memo del planner con tope propio** (`cacheSet` + `MOUSE_PLAN_CACHE_LIMIT = 40000`,
   evicción FIFO): el almacén más consultado del sistema ya no comparte el límite de 6000.
4. **F4 · versión del `narrow` siempre hacia arriba** (`highestKnownVersion + 1` sobre el ledger
   del run, no sobre el número del modelo).
5. **F5 · el prompt pide evolucionar, no renombrar** (`RENAMING IS NOT EVOLUTION`): renombrar
   reinicia las estadísticas de la pregunta.
6. **F6 · intervención del operador ("Force System-2 consult")**: campo de directiva (≤500
   caracteres) + botón que encola la orden y la consume en el **siguiente borde de intento** —
   nunca dentro de un juego — **incluyendo la aceptación** ("acaba de ganar" es el mínimo local
   del que se quiere escapar). La consulta lleva la directiva + la evidencia del intento
   (`task: 'operator_directive'`), su salida pasa las puertas normales (cita
   `evidence_ref.operator_directive`, cambio evaluable, floor del ledger), y una propuesta que
   la ignore es `UNSUPPORTED`. **Uso recomendado:** al ver el trigger mix 0/112/1 con la misma
   tríada de movimientos, *"Cats advance in formation, keeping one horizontal line while far
   from the Mouse — value that, or make it a policy question"*. Tile `Operator interventions`
   + `catFormationFacts` post-juego (spread / `left_behind` **medidos**) como evidencia lista.
7. **M-B-05 · la lectura del tablero es obligatoria** (ver SPEC §10): antes de proponer un cambio,
   System 2 debe devolver `board_reading` — qué posiciones leyó (trazables a la evidencia recibida),
   cómo calculó cada medida (definición reproducible) y qué números le salieron por caso. Sin trabajo
   mostrado ⇒ `UNSUPPORTED`. La lectura viaja **cegada** al juez de consenso (sus números separan los
   casos o son evidencia en contra) y se archiva con la mutación, pero **nunca** entra al rule set ni
   a V(s): el artefacto de aprendizaje sigue siendo sólo lo que Jev evalúa (I1). Motivo: exigirle al
   modelo cálculo mental no formulado era exactamente lo que produce tríadas que sólo se re-pesan.

---

## 4. Estado del motor hoy

- **Modos de aprendizaje por ruta**: `off` · `collect` (mide y encola, sin consultar) · **`consolidate`**
  (registra y consulta **una vez** en el borde del intento) · `live` (revisa dentro del juego) — default
  todavía `live` hasta el A/B.
- **Presupuestos**: consultas mid-game (`Course corrections / Game`), consenso de jueces (2 por juego),
  casos por ply, intentos y juegos por intento.
- **Panel**: nodos, hojas, llamadas Jev, reuso, transposiciones, **cortes**, confianza media, política,
  `Path cases`, `Course corrections`, **`Reflections`**, **`Consolidations`**, **`Trigger mix`**,
  **`Revisions`**, **`Judges (a/r/n)`**, `Neutral atom fallbacks`.
- **Payload a System 2**: `board_digest`, `current_rules`, `measured_error`, `loss_report` (con verdad
  computada), `path_brief`, `consolidation_brief`, `revision_digest`, `atom_stats`/`dead_atoms`,
  `atom_accuracy`/`uninformative_questions`, `attempt_cost`, `battery_in_use`, `path_learning`, `telemetry`.
- **Prompt**: contrato honesto (sin capacidades retiradas), rango del floor renderizado desde la constante,
  coste real de Jev, y el aviso de que **un juez lee el diff** y de que conviene pedir el cambio más estrecho
  que explique la evidencia.

---

## 5. Qué falta, en orden, y cómo se medirá

| # | Pendiente | Cómo se decide |
|---|---|---|
| 1 | **M-B-03/04 · verdad de acción + `ACTION ACCURACY`**: el solver expone la **jugada ganadora** (hoy la descarta) y se mide, en plies con veredicto, si acierta el **buscador**, si acierta el **argmax de la política** y quién tiene razón cuando discrepan | Responde con datos la pregunta "¿debería System 1 elegir las acciones?"; hoy el 30 % de `argmax hit` **no es atribuible** |
| 2 | **A/B de modos** (`live` vs `collect` vs `consolidate`) con **las mismas semillas** y regla de adopción **declarada antes** de correr (victorias y hojas/llamadas) | Decide el default de `Path Learning`; hoy es `live` por precaución |
| 3 | **`tie_break`** (el prior decide sólo donde el valor **no** distingue) y, si se justifica, **`reflex_k`** con la precondición **M-B-14** (sólo estrechar cuando la política demuestre calidad medida) | Brazos del mismo A/B; `reflex_k` como **laboratorio**, nunca default |
| 4 | **F1 · UI del floor**: el campo *Confidence Floor* del header sólo siembra el rule set neutro; el rule set guardado manda | Unificar (aplicar el campo al rule set en uso) **o** mostrar en el HUD el valor efectivo y el del artefacto |
| 5 | **Aceptación graduada** (best-of-N, o `≥N de M` con re-verificación limpia) | Con p≈0,6 por juego, "ganar todos" con 3 juegos cuesta ≈14 h de run; `≥4 de 5` baja el tiempo esperado a ≈3 intentos |
| 6 | **Coste**: profundidad 4 vs 5, y poda real (hoy estructuralmente inerte por el tamaño del batch) | Se mide en hojas por juego y en minutos por intento |

---

## 6. Validación y limitaciones

**Comandos de validación** (offline, sin red):

```powershell
node fox-hounds-harness.selftest.js     # suite completa · 0 fallos · exit 0
node jev-relay.js --selftest            #  21 checks · 0 fallos
```

**Qué cubre el selftest**: gates estructurales sobre el fichero (markup, contratos, invariantes), el
auto-test del motor embebido en la página, y comportamiento end-to-end con **stubs deterministas** de Jev y
del LLM (modos de aprendizaje, presupuestos, jueces, journal de revisiones, consolidación, precisión por
pregunta y doctrina de fallo).

**Limitaciones, dichas en voz alta:**
- Las cifras de §2 son la **telemetría de un run** (un vendor, `jev-1.13.0`); no son un benchmark, y los
  minutos por intento son una **derivación** (latencia × llamadas ÷ concurrencia).
- **Nada de lo añadido en esta sesión se ha probado contra Jev/LLM reales** (faltan claves válidas): todo
  está validado con stubs. La calidad de las propuestas, de los votos del juez y el ahorro real de la
  consolidación sólo se verán en un run real.
- El **consenso** es del **mismo modelo**: se mitiga con medición primero, con `rationale`-blinding y con
  quórum declarado, pero no es un par independiente de verdad (eso requeriría otro modelo o evidencia
  distinta, que es justo lo que hacen J1/J2).
- **La intervención del operador es la única entrada no medida del sistema** (una instrucción humana,
  no una trayectoria): se mitiga exigiendo cita, cambio evaluable y medición limpia posterior, pero
  el operador puede pedir algo que los datos no sostienen.
- Los **factos de formación** post-juego (`catFormationFacts`) están implementados y con test, pero
  todavía **no alimentan ninguna evidencia** (`loss_report`/`path_brief` no los llevan): son el
  insumo natural para que la próxima System 2 pueda proponer *"avanzar en formación"* desde datos,
  no desde la directiva del operador.

---

## 7. Anexo · mapa de ficheros y artefactos

| Fichero | Papel |
|---|---|
| `fox-hounds-harness.html` | El harness completo (motor, UI, prompt de System 2, auto-test embebido) |
| `fox-hounds-harness.selftest.js` | Validación offline: gates estáticos + auto-test + comportamiento con stubs |
| `jev-relay.js` | Relay de loopback para la pared CORS de TypeSafe (guarda la clave en el servidor) |
| `SPEC-APRENDIZAJE-DIFFS-Y-ACCIONES.md` | Especificación: SPEC-01 (hecho), SPEC-02 (propuesta), M-C-01, §6 auditoría, §7 alcance |
| `INFORME.md` | Este documento |
| `fox-hounds-harness.*-backup.html` | Copias de fases anteriores (referencia histórica) |

**Artefacto de aprendizaje**: un JSON con `version`, `rationale` (prosa, **no** evaluada), `confidenceFloor`,
`weights` (sólo preguntas de valor), `policyWeights` (sólo la fusión entre preguntas de política) y `battery`
(preguntas con `type`, `instructions`, `criteria`, `used_as` y, para las de política, `options_from`,
`subject` y `aggregate`).

**Invariantes que ningún cambio futuro debería romper** (los vigila el selftest): (I1) el artefacto es
siempre un rule set evaluable; (I2) el harness no inventa valores ni opiniones; (I3) la política ordena,
nunca descarta un movimiento legal; (I4) toda mutación intra-juego es hipótesis y se re-verifica limpia;
(I5) lo que se reporta al operador son medidas.

---

## 8. Fase 2 (18/09/2026) · Por qué no había variedad, y el ratón con currículum

**El diagnóstico de la "política por defecto"** — el usuario observó que tras un run ganador el
artefacto copiado era idéntico a la compilación inicial. Auditoría de 6 capas: el run **no podía**
producir variedad, por diseño. (1) El *Required JSON shape* del prompt era un **molde con los ids de
la batería embarcada ya escritos** — un modelo al que se le da la forma con los ids puestos devuelve
esos ids (y de ahí salió siempre `cats_win_forecast` + `mouse_containment` con prosa reescrita).
(2) El contrato premia el cambio mínimo y el no-cambio. (3) Intra-juego sólo se mueven números
(`NARROWABLE_KINDS`): las 9 correcciones `narrow` del run nunca tocaron el rubric. (4) **La primera
victoria rompía el bucle** (`break`), y la medición contra el greedy tiene ≤4 bits de información:
los seeds del trial matrix **no se consumen** (`config.seed` no entra en el juego), así que el
espacio real son las 4 columnas de inicio del ratón. (5) La ruta de pérdida tampoco desancla (no
hay memoria de lo ya medido). (6) Nada de esto era visible (`Trigger mix` sólo contaba en
`consolidate`, no había tile de preguntas descartadas ni export del historial).

**Dos incoherencias de fondo arregladas de paso:** (A) `solveAgainstGreedy` resolvía **juego
perfecto de ambos lados** mientras su nombre, su `covers` y su `opponent` decían "contra el ratón
fijo" — todos los labels `CONTRADICTION`, `against_truth` y `atom_accuracy` eran de un juego **más
difícil** que el jugado. (B) En partidas humanas, a Jev se le seguía describiendo el planificador
greedy (`opponentDescription()` no tenía rama para el humano). Y un **bug latente**: `describeTruthGap`
interpolaba `truth.plies` pero las filas traen `plies_to_end` — se expuso cuando el oráculo nuevo
alcanzó la rama "THE VALUE WAS RIGHT" y un "undefined plies to the end" llegó al payload.

**Qué se implementó (SPEC §8, M-D-01…M-D-09):** el modelo del ratón como **un solo concepto** hilado
en los tres sitios que deben coincidir (quién juega, qué predice el search, qué etiqueta el oráculo);
planner **code-only** (nunca Jev, nunca el rule set bajo test) con presupuesto y memo; **currículum**:
cada victoria limpia suma un ply de planificación al ratón (los gatos quedan fijos; invariante
`mouse ≥ cats`), con techo honesto (`Curriculum ceiling: the limiter is the EVALUATOR`); una escalada
es un mundo nuevo (cachés y baseline de creencias del ratón débil se descartan, y las claves de caché
llevan el modelo); **prompt desanclado** (placeholders, `tried_rule_sets`, `mouse_model` declarados en
el payload); **gate de procedencia J0** (`evidence_ref` obligatoria con evidencia en mano, si no
`UNSUPPORTED`); tiles `Mouse depth`, `Escalations`, `V(s) vs truth (MAE)`, `Unsupported proposals`;
`Trigger mix` también en `live`; botón **`Copy Run Journal JSON`** (el historial que antes se perdía:
las 9 correcciones, jueces, revisiones, currículum, telemetría); procedencia de la aceptación
(`match.acceptedAt`) visible al copiar. **El criterio de aceptación no cambió: cambió la vara.**

**Qué observar en el próximo run real (con claves):** `mouse plannerN` en las jugadas del ratón ·
`ESCALATION k/3: the Mouse now plans m plies ahead` · `UNSUPPORTED proposal` (si el modelo no cita la
evidencia que le mostraron) · el tile `V(s) vs truth (MAE)` y si baja con las hipótesis · tiles
`Mouse depth (cats/mouse)` y `Escalations` · `Curriculum ceiling` si el evaluador encuentra techo ·
`Copy Run Journal JSON` para ver TODAS las versiones del set, no sólo la aceptada.

**Nota de coste:** el planner es code-only y acotado (0 llamadas Jev); lo que multiplica el
currículum es el **número de intentos** (cada escalada re-mide al incumbente en el mundo nuevo, y las
respuestas de Jev del ratón débil se re-pagan a propósito). Con la latencia medida de §2
(~82 min de vendor por intento), `Escalate After 1` + `Max Escalations 3` puede cuadruplicar el
presupuesto de un run: el costo por escalada queda en el journal (`telemetry.escalations`,
`attempt_cost`).

---

## Actualización 21/09/2026 · El rule set ya es una fórmula ejecutable

Se completó la pieza central que faltaba. System 2 ya no se limita a reescribir preguntas y pesos:
declara las medidas de entorno en `observations`, mediante primitivos o expresiones declarativas
acotadas. El harness las ejecuta sobre un array inmutable de posiciones; Jev juzga las reglas a partir
del vector resultante; y código compone exclusivamente `V(s) = Σ w_i·rule_i(O(s))`.

La superficie explícita es `createBoardEnvironment(state).Eval(formula)`, donde `formula` es el rule
set canónico producido por `ruleFormulaOf`. La evaluación devuelve su hash, medidas, átomos, valor y
procedencia (`live`, `cached-answer`, `cached-vector` o `cached-value`). System 2 recibe las hojas como
arrays estructurados de posiciones, junto con las medidas/juicios vigentes y, cuando el solver puede
decidirla, la etiqueta `good_for_cats` o `bad_for_cats`. Así puede formular libremente qué distinción
observar entre jugadas buenas y malas. Después de su respuesta, el harness ejecuta la fórmula candidata
sobre esas mismas hojas y la rechaza si alguna medida no es computable. System 2 ya no entrega
`board_reading` con números calculados por el modelo.

Jev recibe `O(s)` y el contexto declarado, no el tablero como atajo para volver a calcular las
métricas. El bloque `policy` es sólo un prior opcional para ordenar movimientos concretos; no es la
ruta de aprendizaje ni sustituye la evaluación de todas las hojas.

El lenguaje `expr` no evalúa código del modelo: interpreta un AST con agregados sobre
`cats|mouse|all`, aritmética, `abs`/`neg`/`clamp` y primitivos registrados, con límites de 64 nodos y
profundidad 8. Una especificación desconocida, sin rango o no finita se rechaza con motivo. Los hashes
y las cachés incluyen la formulación de las observaciones, de modo que reespecificar una medida invalida
el juicio anterior incluso cuando ambas fórmulas producen casualmente el mismo número.

Se arreglaron además los bloqueos de la implementación parcial: el `ReferenceError` al describir/difundir
observaciones, la pérdida silenciosa de `observations` en revisiones parciales, placeholders con espacios
o letras `s`, el diff que confundía preguntas y medidas, y las cachés incompletas al escalar/resetear.

### Dos planificadores: evidencia exhaustiva y juego rápido

El modo aprendizaje conserva el fan-out completo: en cada pasada, todos los tableros resultantes de los
movimientos legales del gato se lanzan mediante `Promise.all`. Es deliberado: esas hojas buenas, malas o
inciertas son evidencia para descubrir y explicar el rule set. El ratón determinista sólo genera un hijo
por nodo MIN, de modo que alfa-beta apenas tiene oportunidad estructural de ahorrar trabajo en este modo.

El juego humano contra los gatos usa ahora otro planificador, `play-pv-alpha-beta`. Cada nodo resuelve
primero el hijo principal —ordenado por la PV anterior y los priors de Jev— para establecer `alpha` o
`beta`; después lanza los hermanos en lotes especulativos de dos. Cuando la ventana se cierra, los hermanos
aún no iniciados se omiten. Toda hoja no terminal que sí se evalúa sigue pasando por
`Environment.Eval(ruleSet)` y Jev: la poda sólo combina cotas procedentes de esos valores, no introduce
una heurística local ni llama a System 2.

La confianza se conserva como evidencia interpretable para el aprendizaje, pero ya no se usa como una
cota matemática. Una confianza baja no desactiva alfa-beta en PLAY. La tabla de transposiciones distingue
valores `EXACT` de cotas `LOWER` y `UPPER`, evitando reutilizar como exacto un nodo que terminó por corte.

La interfaz expone fan-out de aprendizaje, pasadas PV, primeras ramas, cortes, hermanos omitidos, cotas
reutilizadas y el pico de concurrencia Jev. El semáforo global sigue limitando a 8 las llamadas vivas.
