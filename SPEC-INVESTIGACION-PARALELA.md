# SPEC · Investigación en paralelo: varios mundos de una familia a la vez, con intercambio

Estado (04/10/2026): **PA1, PA2, PB1 y PB2 implementados en la cuadrícula** (`unknown-world@1`). PB4 en parte: duplicación,
callejones leídos y modelos por ventana; la convergencia de hipótesis (con el Juez) queda pendiente. PB3 son los
experimentos con LLM real: pendientes. Incorpora dos evaluaciones externas: la primera dio forma a la propuesta; la
segunda cerró los contratos de presupuesto, ventanas, publicaciones y confirmación antes de construir el tablón (§3, §5,
§6, §7).

## 1. La pregunta y para qué sirve

¿Se puede acelerar el aprendizaje corriendo experimentos en paralelo, en varios mundos de la misma familia, e
intercambiando información?

- **Para medir la capacidad de un investigador, no.** Paralelizar mezcla lo que hace cada investigador con lo que aporta
  el reparto. Lo que medimos hoy (un investigador, un presupuesto, el mundo decide) y la auditoría del método
  (SPEC-AUDITORIA-METODO) siguen siendo la referencia para eso.
- **Para encontrar soluciones antes, sí puede servir.** Es un uso práctico: más evidencia por unidad de tiempo, ramas
  alternativas que no obligan a abandonar la principal y fracasos bien documentados que nadie más tiene que repetir.
- **Matiz:** también es un experimento legítimo, pero de **otra cosa**: mide la capacidad del **sistema colectivo**
  (investigadores, reparto y canal de intercambio). Por eso es una **condición declarada y separada**, como el modo `meta`
  de la experiencia (SPEC-INVESTIGADOR-ASISTIDO §12.1). El finding la declara en `parallel` (§10). Sus runs no se comparan
  con los de la condición individual (P6/Q7) salvo en los diseños de §6, hechos para eso.

El coste total puede subir (coordinación, trabajo duplicado, más comprobaciones) o bajar (un resultado negativo
compartido ahorra a los demás el mismo callejón). Cuál de las dos cosas pasa es una pregunta empírica (§6), no un
supuesto.

## 2. En qué se apoya y qué se ha añadido

| pieza | dónde | qué aporta aquí |
|---|---|---|
| **Familia de mundos** | `worlds/grid/family.ts` (`boardOf`) | tableros que comparten la ley y cambian tamaño, piezas y salidas |
| **Tramos de la familia** (nuevo) | `family.ts`: `FAMILY_INDEX`, `explorationIndices`, `examOverlap` | validación 1–499, exploración 500–999, ciegos desde 1000: nunca se tocan (E1) |
| **Validación y confirmación ciega** | `learn/protocol.ts` | los mundos que **no** se pueden explorar: son el examen |
| **Rol `exploration`** (nuevo) | `learn/objective.ts`, `protocol.ts` | un lugar del investigador, nunca chequeado, validado ni confirmado |
| **Confirmación contada** (nuevo) | `ProtocolOptions.confirm` | el protocolo pregunta antes de gastar una confirmación ciega (§5.4) |
| **Jev compartido en vuelo** (nuevo) | `EvaluatorOptions.inflight` | dos búsquedas a la vez en dos tableros piden una sola vez el mismo juicio |
| **Tablón** (nuevo) | `learn/assisted/board.ts` (`TeamBoard`, `PeerChannel`) | versiones selladas, publicaciones idempotentes, evidencia recuperable, libro del examen |
| **Lote equipo** (nuevo) | `orchestra/team.ts` (`team@1`), `lab team` | miembros a la vez, papeles, presupuesto declarado, informe y auditoría del equipo |
| **Grabación y reanudación** | `ReplayLog`, `--resume` | canal `peer`: un run reanudado lee del tablón lo que leyó |
| **Lector de registros, senior** | `record.ts`, SPEC-ORQUESTADOR §3.3 | el senior por miembro funciona como en un lote |

## 3. Principios

- **E1. Los mundos de examen nadie los explora.**
  - Los tableros de exploración salen de un tramo de la familia disjunto de los de validación y de los ciegos
    (`FAMILY_INDEX`); cada miembro de un equipo tiene su propio sub-tramo (`--explore-offset`, de 20 en 20).
  - El protocolo rechaza una confirmación ciega en un lugar que no sea ciego (`role !== 'confirmation'` o ya visto).
  - El journal guarda qué tableros exploró cada run (`hidden_from_the_learner.exploration`, con su índice).
- **E2. Lo compartido es evidencia con procedencia, no conclusión.**
  - Una entrada dice: tipo, afirmación, intervención, lo observado y el alcance, **más los registros del laboratorio** que
    la respaldan (§5.2): el lector distingue «el compañero interpreta X» de «el laboratorio devolvió Y».
  - Se cita como `peer:<miembro>#<n>`; el finding la separa (`grounded: peers`).
- **E3. Ley común frente a parámetros locales.**
  - Toda entrada lleva **dónde se observó**, y eso lo pone el laboratorio, no el investigador: tamaño, piezas y si el
    tablero es común a todo el equipo (`same_board_for_the_whole_team`).
- **E4. Independencia antes de comunicar.**
  - El tablón se lee por **ventanas** de `window` rondas, y cada ventana es una **versión inmutable** (§5.2).
  - Lo que se publica lo **elige el investigador**; nada se comparte solo.
- **E5. Trabajo complementario, decidido arriba.** El papel de cada miembro lo fija quien declara el equipo, como primer
  mensaje (`agent:team`). El equipo no se lo reparte en el tablón.
- **E6. El puro sigue puro.** Sólo el asistido tiene tableros de exploración y tablón. Un puro puede ser miembro de un
  equipo **sin intercambio** (condición «independientes»): comparte sólo el libro del examen.
- **E7. Todo se graba y se reanuda.**
  - Cada lectura pasa por el log del run (canal `peer`).
  - Cada publicación tiene una **clave idempotente** (`<miembro>#<n>`): un run reanudado que vuelve a publicar la
    encuentra y no añade nada, ni vuelve a influir en compañeros vivos.
- **E8. Presupuesto declarado, en uno de dos modos** (§7.1): fijo (el intercambio y la coordinación salen de B) o
  ampliado (B para investigar, el intercambio aparte). Responden preguntas distintas.
- **E9. Validar no es confirmar** (§5.4). La validación en la familia da feedback y orienta la búsqueda; la confirmación
  final es en tableros que nadie del equipo ha consultado, y el equipo tiene un número contado de ellas.

## 4. Modalidad A: un investigador, varios tableros de exploración

**Qué se reparte:** los experimentos. **Qué aporta:** más evidencia por paso, con una sola línea de razonamiento.

- `--explore-places k`: k tableros de exploración (E1), además del laboratorio. Sólo el asistido (E6); el puro lo rechaza.
- El investigador los ve en `places` («a place to explore: you can act and replay here; your model is never checked
  here») y empieza con `--explore` episodios del entorno en cada uno.
- **Cada punto nombra su lugar** (un episodio se juega en un lugar), así que `act` y `replay` se dirigen solos: desde
  `g5@0` de un episodio de `explore2`, se juega en `explore2`. `table` acepta `"place"` para restringirse a un lugar.
- El prompt del asistido gana una sección genérica (`PLACES_SECTION`): sólo palabras de la interfaz, nunca cómo usarlos.
- **Contrato del paso** (igual en serie y concurrente):
  1. las peticiones se responden en el orden pedido, salvo los `replay`;
  2. cada `replay` se **admite** en su turno (presupuesto, modelo, punto, semilla);
  3. luego se juegan todos: a la vez (`--place-concurrency concurrent`, por defecto) o uno tras otro (`serial`);
  4. sus episodios se nombran **en el orden pedido** cuando todos han terminado.
  - Consecuencia: una petición del mismo paso no ve el episodio de un `replay` de ese paso. Los `act` sí se hacen antes, en
    su orden, así que un `replay` puede partir de un `act` anterior del mismo paso.
- **Serie o concurrente dan los mismos episodios** (mismas semillas, mismo Juez): sólo cambia el reloj, que el operador
  ve en `step_clock` (tiempo de cada `replay` y del paso). Esto es lo que permite la comparación de §6.
- Sin `--explore-places`, el run es exactamente el de antes: mismo prompt, mismas respuestas, mismo journal (salvo
  claves nuevas en `config`).

## 5. Modalidad B: varios investigadores, varios mundos, un tablón

**Qué se reparte:** hipótesis, estrategias y experimentos. **Qué aporta:** caminos alternativos explorados a la vez.

### 5.1 El equipo (`team@1`)

```json
{ "id": "trio-s22", "lab": "grid", "condition": "communicated",
  "args": ["--seed", "22", "--attempts", "8"],
  "window": 3, "exchange": true, "confirmations": 2, "explore_places": 2,
  "budget": { "mode": "fixed", "tokens": 600000, "coordination_tokens": 0 },
  "members": [
    { "id": "a", "role": "Identify the rule." },
    { "id": "b", "role": "Try to refute the rule the team holds." },
    { "id": "c", "role": "Look for where the rule fails.", "agent": { "id": "senior", "role": "senior" } } ] }
```

- `lab team <team.json>` lo corre (o lo reanuda) en `runs/teams/<id>/`: el tablón, un journal por miembro,
  `team-report.json` y `team.txt`.
- **Todos los miembros corren a la vez**: una ventana espera a que todos la pasen.
- Cada miembro es un run normal (`--team <dir> --member <id>`), con el mismo laboratorio base (misma semilla, misma
  familia) y su propio sub-tramo de exploración. Su `finding` lo declara en `parallel.team`.
- `exchange: false` es la condición «independientes»: sin tablón, mismo libro del examen.
- Un miembro puede llevar su senior (`agent`), como en un lote; y su propio modelo (`BatchOptions.llmFor`).
- Encaja con las ramas de SPEC-ORQUESTADOR §5.5: el backtracking que en grid-s22 un investigador hizo en serie (rejugar el
  modelo de la ronda 8) puede ser otra rama del equipo.

### 5.2 El tablón: contratos

- **Publicar** (dentro de `investigate`, cuenta como paso):
  `{"publish": {"kind": "result" | "dead_end" | "method", "claim", "intervention", "observed", "scope", "evidence": [...]}}`.
  - `evidence` son referencias a registros propios: episodio `g12`, punto `g12@4`, act `act3`, paso de investigación
    `r3.2` (un paso **ya respondido**: no el actual). `result` y `dead_end` necesitan evidencia; `method` no.
  - El laboratorio adjunta a cada referencia **su registro tal como lo respondió** (los fotogramas de un episodio, la
    imagen de un punto, la respuesta de un act, las peticiones y respuestas de un paso) y **dónde** se observó (E3).
  - Una referencia sin registro detrás hace rechazar la publicación.
- **Versiones inmutables.**
  - La entrada se publica en la ventana de su ronda: `ceil(ronda / window)`.
  - La versión w contiene todo lo publicado en las ventanas 1..w y se **sella** cuando todos los miembros han terminado
    la ronda `w × window` (o han terminado su run). Se escribe una vez y no cambia.
  - Un miembro lee la versión w en la ronda `w × window + 1`, la que la abre; fuera de esas rondas el tablón está cerrado.
    Leer espera a que la versión esté sellada.
  - Toda lectura nombra su versión; el finding la lista (`parallel.team.read`).
- **Idempotencia.** La n-ésima publicación de un miembro es `<miembro>#<n>`. Publicarla de nuevo (reanudación) la
  encuentra y no añade nada; con otras palabras es un conflicto: queda la primera y el journal lo dice. Lo que se responde
  al investigador es igual en vivo y reanudado.
- **Leer:** `{"peers": "list"}`, `{"peers": "open", "items": [...]}`, `{"peers": "open", "item": "a#1", "evidence":
  "g12"}` (el registro completo detrás de una evidencia), `{"peers": "find", "words", "select"?}`. Cada respuesta cuenta
  como paso.
- **Los callejones son de primera clase** (`dead_end`), pero el prompt pide decir bajo qué condiciones: descartar una
  intervención en un lugar no demuestra que la vía esté agotada.
- **Aparte, para el operador** (`board/operator/`): las claves de las intervenciones detrás de cada entrada. Nunca se
  sirven.

### 5.3 Coordinación

- **Sin coordinador:** cada miembro lee en las ventanas y decide solo. (Implementado.)
- **Senior por miembro:** como en un lote (`agent` con `role: senior`). (Implementado.)
- **Senior de equipo**, que lea el tablón y los registros y escriba a cada miembro: pendiente. Su coste cuenta como
  coordinación (§7.1).
- **Planificador** que abra y cierre ramas y reasigne presupuesto por un criterio computable (Q3): pendiente.

### 5.4 El examen de un equipo

- **Validación durante la búsqueda:** la de siempre, por miembro (`--validations`), en los tableros de la familia
  (comunes al equipo). Da feedback y queda registrada; un tablero donde falla se vuelve laboratorio.
- **Confirmación final:** en tableros ciegos que **nadie del equipo** ha consultado. Salen del libro del examen del
  equipo (`board/exam.json`): ninguno se da dos veces, y un run reanudado recibe los mismos (clave por miembro y
  confirmación).
- **Presupuesto de confirmaciones del equipo** (`confirmations`): cada vez que el modelo de un miembro se sostiene en toda
  la familia, gasta una. Agotadas, el protocolo no confirma y se lo dice (`no_blind_confirmation`). Así «el equipo
  resuelve si cualquiera resuelve» no multiplica las oportunidades de pasar el examen.

## 6. Cómo saber si sirve

**Modalidad B, con réplicas (seeds):**

| condición | qué es |
|---|---|
| **1. Solo** | un investigador con presupuesto total B |
| **2. Independientes** | `team@1` con `exchange: false`, N miembros |
| **3. Comunicados** | `team@1` con `exchange: true`, N miembros |

- 2 frente a 1 es el valor de explorar más ramas; 3 frente a 2, el del intercambio.
- Cada comparación se hace en **uno de los dos modos de presupuesto** de §7.1, declarado, nunca mezclados.

**Modalidad A: separar variación de concurrencia** (segunda evaluación, punto 1):

| condición | qué es |
|---|---|
| **A0** | un investigador, sin tableros de exploración |
| **Ak-serie** | k tableros, `--place-concurrency serial`, mismos pasos |
| **Ak-concurrente** | k tableros, `--place-concurrency concurrent`, mismos pasos |

- Ak-serie frente a A0 mide el paquete «más mundos + más evidencia por paso» a igualdad de pasos: valor científico de la
  variación entre mundos.
- Ak-concurrente frente a Ak-serie es la ganancia de ejecutar a la vez. Con las mismas peticiones y las mismas respuestas
  del Juez, los episodios coinciden (lo prueba `test/parallel.test.ts`): la diferencia entre las dos condiciones sólo
  puede venir del reloj y de lo que el LLM decida con él, nunca de lo que el mundo respondió. Se compara el reloj por paso
  con `replay` (`step_clock`) y el reloj hasta la aceptación, con réplicas.

**Medidas:**

- **Éxito:** modelo aceptado (validado y confirmado a ciegas); RR cuando hay verdad, como lectura del operador.
- **Tiempo:** hasta la primera aceptación, en reloj (`team.first.seconds`) y en rondas.
- **Coste total:** tokens, llamadas a Jev, confirmaciones gastadas.
- **Duplicación** (capacidad nueva, PB4): intervenciones con la misma clave (mismo tablero, misma posición, mismo
  movimiento o mismo modelo) hechas por más de un miembro (`audit.duplication`).
- **Callejones leídos** (capacidad nueva, PB4): cada `dead_end` abierto por otro miembro y si después repitió una
  intervención de su evidencia (`audit.dead_ends`). **No repetirla es compatible con un ahorro, no lo demuestra**: no
  sabemos si la habría repetido sin leerla.
- **Convergencia:** de momento, cuántos modelos distintos tenían los miembros al final de cada ventana
  (`audit.models_by_window`). El mismo modelo no es la misma hipótesis: la convergencia de hipótesis necesita al Juez
  (pendiente).
- **Método:** la auditoría (SPEC-AUDITORIA-METODO) de cada miembro, por ejemplo si se lee como hecho lo que era
  hipótesis de otro.

La varianza entre runs es grande (la continuación grid-s22 osciló entre 3/8 y 8/8): siempre con réplicas.

## 7. Coste

Cifras medidas en los runs de la cuadrícula (02–03/10, Luna, 8 rondas): investigador ~$0.08 por run (52 % de la entrada
en caché), con senior Sol ~$0.33; Sol solo $1.29; Qwen local 0 $; reloj 110–340 s por ronda; Jev en los checks
10.000–44.000 llamadas por run.

### 7.1 El presupuesto: dos experimentos distintos

| modo | qué recibe cada miembro | qué pregunta responde |
|---|---|---|
| **fijo** | `(B − coordinación) / N`; leer y publicar sale de ahí | ¿compensa gastar parte de B en comunicarse? |
| **ampliado** | `B / N + intercambio`; la coordinación aparte | ¿qué añade comunicarse, pagándolo además? |

- El tope por miembro es `--max-tokens` de su run. Leer y publicar viven dentro de sus llamadas al LLM, así que en modo
  fijo el intercambio ya sale de su parte; el informe dice lo gastado y si cabe en lo declarado (`budget.within`).
- **El reloj no es R/N.** La búsqueda puede necesitar una secuencia de descubrimientos que no se reparte entre ramas, y
  las ventanas hacen esperar al miembro más lento. Es una medida, no un supuesto.

### 7.2 Modalidad A

- **LLM:** los mismos pasos, respuestas más largas (más episodios y lugares en el cuaderno). Estimación con k = 2–3:
  +30–80 % de tokens de entrada; con Luna, de $0.08 a ~$0.10–0.14 por run.
- **Jev:** **no es cero.** `replay` juega con la búsqueda del modelo, y el evaluador consulta al Juez en cada posición
  nueva; jugar en más tableros son más posiciones distintas. El coste depende del instrumento (un `act` o una `table` no
  consultan al Juez; un `replay` sí) y del modelo (un modelo cuyas reglas no lee el `output` no lo consulta). Los checks
  no cambian: sólo se chequea en los laboratorios.
- **Reloj:** los `replay` de un paso corren a la vez; el Juez es la espera dominante (red), así que la ganancia depende de
  su concurrencia (8 peticiones a la vez) y del caché compartido.

### 7.3 Modalidad B

| | 1 (solo) | 2 (N independientes) | 3 (N comunicados) |
|---|---|---|---|
| LLM | B | B en modo fijo | B en modo fijo; B + intercambio en ampliado |
| Jev | checks de 1 run | **N × checks** | **N × checks** + `select` de las lecturas |
| Confirmaciones | las del run | contadas por el equipo | contadas por el equipo |
| Reloj | R rondas × 110–340 s | medido (no R/N) | medido; las ventanas esperan al más lento |

- **El coste oculto sigue siendo Jev:** cada miembro chequea su modelo. Acotarlo con menos episodios por check o
  validando sólo el candidato del equipo queda abierto (§9).
- **Las lecturas del tablón** cuestan como la experiencia: un paso y unos 2–5k tokens por lectura; abrir la evidencia de
  un episodio cuesta lo que sus fotogramas.
- **Ejemplo: tres Lunas comunicadas con un senior Sol.** LLM ≈ 3 × $0.08 + $0.25 + lecturas ≈ $0.50–0.55; Jev ≈ 3 ×
  10.000–44.000 llamadas; hasta tres ramas a la vez.

## 8. Plan y estado

- **PA1 · Tableros de exploración.** Hecho: tramos disjuntos (E1), `--explore-places`, `--explore-offset`, el punto
  nombra el lugar, `table` con `place`, registro en el journal.
- **PA2 · Modalidad A en el asistido.** Hecho: sección del prompt, paso en dos fases, `--place-concurrency`,
  `step_clock`, Jev compartido en vuelo. Falta correr A0 / Ak-serie / Ak-concurrente con réplicas (PB3).
- **PB1 · El tablón.** Hecho: `publish` y `peers` (list/open/find/select), versiones selladas, publicaciones idempotentes,
  evidencia recuperable, lecturas grabadas (canal `peer`), citas `peer:` en el finding.
- **PB2 · El lote equipo.** Hecho: `team@1`, `lab team`, papeles, ventanas, presupuesto en dos modos, confirmaciones del
  equipo, reanudación, informe.
- **PB3 · Los experimentos de §6** con réplicas y LLM real. Pendiente (coste en dinero: decisión del autor).
- **PB4 · Auditoría para equipos.** En parte: duplicación, callejones leídos y modelos por ventana (código). Pendiente:
  convergencia de hipótesis con el Juez, y la auditoría del método (J3) sobre citas `peer:`.

## 9. Preguntas abiertas

- **Checks compartidos.** ¿Cada miembro comprueba su modelo, o el equipo propone uno y se comprueba una vez? Lo segundo
  ahorra Jev pero acopla a los miembros. Vía intermedia: checks propios con menos episodios y validación sólo para el
  candidato del equipo.
- **Ventanas fijas o pedidas.** Hoy son fijas. Pedirlas con coste en pasos es más natural pero erosiona E4, y haría falta
  definir qué versión se lee cuando no todos han pasado la ventana.
- **Mismo mundo base o mundos distintos.** Hoy todos los miembros comparten el laboratorio (misma semilla) y cada uno
  explora su propio tramo. Un laboratorio distinto por miembro (otro tablero de la familia como base) está por hacer.
- **Qwen local en paralelo.** Con vLLM en una sola GPU, N miembros compiten por el mismo servidor: medir el rendimiento
  con concurrencia antes de prometer aceleración.
- **¿El tablón contamina el método?** Un miembro que adopta sin probar la conclusión de otro es lo que la auditoría
  debería marcar (J3 sobre `peer:`).
- **Determinismo con concurrencia.** Serie y concurrente piden al Juez el mismo conjunto de juicios mientras el caché no
  desaloje (20.000 entradas). En runs muy largos, el orden de desalojo podría cambiar qué se pide; el log tolera otro
  orden, no otro conjunto.
- **Laboratorios de leyes** (cells, messages, orbit): ni tableros de exploración ni equipos todavía.

## 10. Cómo se usa

```bash
# Modalidad A: dos tableros de exploración, replays a la vez
node --experimental-strip-types scripts/lab.ts start grid --researcher assisted --explore-places 2

# Lo mismo en serie (para separar variación de concurrencia)
node --experimental-strip-types scripts/lab.ts start grid --researcher assisted --explore-places 2 --place-concurrency serial

# Modalidad B: un equipo
node --experimental-strip-types scripts/lab.ts team team.json
```

- El journal de cada run: `exploration_game` con `place`, `step_clock`, `team`, `peer_publish`, `peer_read`,
  `operator_interventions` (operador).
- El finding: `parallel.exploration_places`, `parallel.concurrency`, `parallel.team` (miembro, ventana, intercambio,
  publicado, leído) y `grounded: peers` en las afirmaciones que citan el tablón.
- El equipo: `runs/teams/<id>/team-report.json` y `team.txt`, con la auditoría aparte (`audit`, sólo operador).
