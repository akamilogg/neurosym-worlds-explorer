# SPEC · El objetivo: la métrica de progreso que define el operador

**Fichero:** `SPEC-OBJETIVO.md`
**Estado (27/09/2026):** implementada, O1–O5 (§7). Parte del primer run real de orbit@1 con el prompt común y el
artefacto con `output` (§1) y del de la cuadrícula `--seed 22` (§1.1). También implementado: Jev solo se pregunta si el
`output` lee las reglas (§9.4), y un modelo que se sostuvo se valida sin comprobarlo otra vez (§3.3). Queda abierta la
pregunta del criterio frente al ruido (§9.6) y falta la evidencia de §8 con LLM real. Generaliza lo que hoy está repartido entre `lib/scripts/run-orbit.ts` y
`lib/scripts/run-grid.ts`.

---

## 1. Motivación: lo que mostró el run de orbit del 27/09/2026

`./run-orbit.ps1 --seed 3 --level 1` (System 2 `openai/gpt-6-sol`, Jev real, 634 s). La ley se **aceptó en la ronda 6**,
con validación en la familia y doble confirmación ciega. La recuperación de la ley frente a la oculta, calificada por
el operador, fue de **0,75**.

| Ronda | Qué pasó |
|---|---|
| 1–3 | En su único laboratorio diseña experimentos controlados: salidas en reposo a distancias 10, 20, 30 y 40, y el mismo lanzamiento con `m = 1` y `m = 10`. Mide aceleraciones con segundas diferencias y corrige solo un error de método (la segunda diferencia de la fila `i` corresponde a la separación de la fila `i − 1`). Llega a 170/r^2,7 hacia el centro; la ley oculta es r^−2,66 |
| 4 | Pide validar. Se sostiene en `setup3` (un centro) y falla en `setup1`, `setup2` y `setup4` (dos y tres centros), que pasan a ser laboratorios |
| 5 | Lanza en los laboratorios nuevos, comprueba que **sumar** la atracción de cada centro explica lo medido y corrige el modelo |
| 6 | Se sostiene en los cuatro laboratorios, en `setup3` y en los dos conjuntos ciegos (χ² ≈ 1, nivel de ruido; error 0,033, el mismo que la ley oculta). **Aceptada** |

**Lo que muestra.** Con solo observar (tablas) e intervenir (`act`), sin pistas sobre el mundo, System 2 condujo una
investigación completa: experimentos controlados, autocorrección de método, aprendizaje a partir de un fallo de
validación (la superposición, invisible en un solo montaje) y un modelo que generaliza a montajes que nunca vio. **El
operador solo definió cómo se contrasta el trabajo**: la forma de la respuesta, los casos de comprobación, el veredicto
por caso, el criterio de "se sostiene" y el protocolo.

**Lo que no muestra todavía.**
- Es un run, una semilla y el nivel más fácil (una ley de potencia con ruido casi nulo).
- **Jev no participó.** Las reglas eran decorativas ("Is radial attraction a plausible qualitative description…? The
  numerical prediction is computed independently in the output code"); el `output` nunca leyó `m.rules` ni `m.V`, y las
  ablaciones sin juez y plana dan exactamente el mismo error que la ley. Es evidencia de *LLM + herramientas + protocolo
  de validación*, no de la parte neurosimbólica en sentido estricto.
- El conocimiento previo ayuda: reconoció una dinámica mecánica.
- Falta la línea base sin instrumentos (`--tools none`).

**La hipótesis que abre.** Dada una interfaz para observar un entorno e intervenir en él, esta arquitectura puede
trabajar por su cuenta en una tarea **si un operador le define una métrica de progreso**: qué respuesta se pide, contra
qué casos se contrasta, qué hecho devuelve el entorno por caso y cuándo se da por buena. Esa métrica ya existe en los
dos mundos, implícita y repartida por los runners. Esta SPEC la extrae a un contrato: el **objetivo**.

### 1.1 La cuadrícula, `--seed 22` (niveles 2 y 4, 8 intentos)

Sin validación: se agotó el presupuesto en el laboratorio.

- **La investigación, buena.** Refutó su primera hipótesis ("la esquina (0,4)") con `table` (todas las derrotas acaban
  con `=` en la última columna). Aisló direcciones de movimiento con pares de `act`. Comparó modelos con `replay` desde
  el mismo inicio y alteró una sola jugada (act21 → g89). Fue cauto con la causalidad.
- **Progreso en el laboratorio.** 4/8 → 5 → 6 → 8/8 → 8/8, y en la ronda 5 el modelo se sostuvo. En las rondas 4 y 5 la
  precisión de acción fue 1,0.
- **Recuperación de reglas: 0,5.** Es severa: tiene las cuatro direcciones propias y las del rival, la victoria
  ("= sin movimiento") y la derrota exacta. Le falta el empate a los 26 turnos.
- **El criterio "se sostiene" es todo o nada con 8 episodios.** Un modelo que gana el 94 % de las veces (la huella
  `obanx1`: 15/16) pasa 8/8 con probabilidad ≈ 0,6, y ≈ 0,35 si además vuelve a jugar los 8 anteriores.
  - En la ronda 5 se sostuvo, pero System 2 no pidió validar. En la 6 lo pidió con el mismo modelo, la comprobación
    nueva dio 7/8 y la validación se rechazó.
  - Las rondas 7–9 fueron parches a inicios concretos, que arreglaban unos y rompían otros.
  - Una de esas derrotas, g81, era ganable (`critical: 0`: la primera jugada tiró la victoria). System 2 no puede
    distinguirla del ruido.
- **Jev, otra vez sin uso, y caro.** El `output` nunca leyó `m`, y las ablaciones fueron idénticas en las 8
  comprobaciones. Desde la ronda 4 la observación era un JSON de la posición entera, distinto en cada posición, así que
  la caché no servía: 6 739 llamadas (129–209 por partida) cuya respuesta no leyó nadie.

### 1.2 `cells@1` con LLM real

**Nivel 1 (regla 105).** Resuelta en la ronda 1: midió la tabla completa "vecindario → símbolo" con `measure`,
comprobó el anillo con una semilla junto al borde y se aceptó con validación y confirmación ciega. Grader: 1,0. Jev no
participó (0 llamadas, 192 evaluaciones sin preguntar).

**Nivel 2 (regla 32).** También grader 1,0, y hasta diseñó una racha que cruzaba el borde para distinguir anillo de
bordes abiertos. Pero la regla vaciaba toda fila en uno o dos pasos, y los puntos de comprobación empezaban en el paso
2: "fila vacía → fila vacía" habría pasado todo. **La aceptación no distinguía el modelo de no saber nada.**

**Correcciones:**
- **Generador:** solo reglas vivas. Desde comienzos al azar, las filas siguen cambiando al final y ningún símbolo
  llena casi toda la fila. Quedan fuera 32, 204, 105, 150…
- **Puntos de comprobación:** desde el paso 0.
- **Líneas base del operador** (`baselines` en el protocolo, O4): modelos que no saben nada se corren sobre los mismos
  casos de cada comprobación. En `cells`: "la misma fila", "la fila anterior", "fila de un solo símbolo". En orbit:
  "repetir el último paso". Si una se sostiene también, el journal marca `check_is_trivial`, y el resumen da
  `trivial_checks` y `accepted_trivially`. System 2 no lo ve nunca.
- **Parser:** acepta `on` dentro de `measure` y de `table`, y `range` es opcional en `table`. En los dos runs, System 2
  perdió pasos por esas formas.

### 1.3 Nivel 2 con la regla 37, y lo que se añadió después

Nivel 2 con la regla 37: aceptado en la ronda 3, grader 1,0, ninguna comprobación trivial.
- **Cómo lo resolvió.** Midió los conflictos por radio (radio 1: sí; radio 2: ninguno) y construyó la tabla de 32
  vecindarios.
- **Qué no vio.** No descubrió que la regla depende solo de un recuento, que se resume en 6 entradas: predice
  perfecto sin la estructura compacta.
- **Jev:** una sola llamada.

Se añadió después:
- **Nivel 3 de `cells`, de segundo orden.** El símbolo siguiente depende del recuento en la fila presente y del propio
  símbolo de la celda en la fila anterior. La fila presente no basta, y los puntos de comprobación empiezan donde hay
  historia suficiente. `act` acepta varias filas (`rows`), igual en todos los niveles.
- **Grader.** Separa predecir de entender (`GRADING_STRUCTURE`, en `cells`, orbit y la cuadrícula): una tabla que
  coincide con una afirmación estructural vale "partial". El journal registra `form`: `compact`, `table` o `mixed`.
- **`messages@1`, la prueba de Jev (H3).** Todo lo que se percibe es texto: mensajes cortos, cada uno con una marca 0 o
  1 que depende de una regla oculta sobre lo que dicen (cuántos artículos pide, si quien escribe está contento, si pide
  prisa).
  - **Familia:** conserva la regla y cambia la redacción. El laboratorio escribe llano (cifras, adjetivos simples); la
    familia usa números en palabras y modismos, negaciones, otros sustantivos y distractores con números.
  - **Diseño comprobado con un LLM falso:** un modelo en código hecho a medida del laboratorio se sostiene allí (24/24)
    y cae en la familia (9–17/24).
  - **Qué mide el operador:** si System 2 delega el significado en reglas para Jev, y la ablación con juez plano dice
    cuánto aportan.

## 2. Principios (heredados; ninguno se relaja)

1. **Cero pistas (`SPEC-MUNDO-FISICO.md` I5).** El objetivo dice la **forma** de la respuesta y los parámetros de lo que
   se contrasta, nunca cómo construirla ni qué es el mundo.
2. **Sin análisis hecho para System 2 (I2).** El veredicto son **hechos por caso**. Nada de estadísticos agregados,
   "dónde fallaste más" ni "tu mejor modelo". Qué significa el veredicto lo descubre System 2 (en el run, entendió solo
   que el veredicto está normalizado: "normalized verdicts are not coordinate errors").
3. **Los únicos juicios del entorno son del operador:** "se sostiene en este sitio" y "aceptado". Son el protocolo, no
   un análisis.
4. **Contra Goodhart.** System 2 puede optimizar la métrica en lugar de la tarea. La familia y la confirmación ciega lo
   impiden: solo lo nunca visto demuestra que generaliza. En el run, el modelo de la ronda 3 se sostenía en su
   laboratorio y la familia lo desmintió.
5. **Métricas del operador aparte (I4).** La verdad, el suelo de ruido, las ablaciones y la calificación viven solo en
   el journal.

## 3. El contrato

Un entorno se conecta declarando cuatro cosas: el **mundo** (estado y dinámica), sus **sentidos** (qué se percibe:
`percept`), sus **acciones** (los parámetros de `act`, `replay`, `simulate`…: `WorldInterface`, `lib/src/learn/prompt.ts`)
y su **objetivo**. El prompt y el protocolo ya son comunes.

```ts
/** What the operator defines for a task. S: a state of the world; C: a case to check a model on. */
interface Objective<S, C> {
  /* 1. The answer: its FORM, told to System 2 in the interface, and how the environment reads it. */
  readonly answer: {
    /** Interface lines: the form only ("a number from 0 to 1 per point", "the pair the last columns will show next"). */
    readonly form: readonly string[];
    /** How an answer is used: compared with what happened (prediction), or handed to a controller (action). */
    readonly use: 'predict' | 'act';
  };

  /* 2. The cases: where a model is checked. Never seen by System 2 before its check. */
  casesIn(place: Place, round: number, purpose: 'check' | 'validation' | 'blind'): readonly C[];

  /* 3. The verdict: one FACT per case, shown to System 2 as is. */
  run(model: Model, place: Place, c: C): Promise<CaseResult>;
  verdictOf(result: CaseResult): unknown;            // e.g. [dx, dy] in [-1, 1], or an episode's score
  readonly verdictForm: readonly string[];           // interface lines: what a verdict is, not what it means

  /* 4. The criterion: does the model hold in a place? The operator's, from facts only (never from the hidden truth). */
  holds(results: readonly CaseResult[], context: { place: Place; previous?: readonly CaseResult[] }): boolean;

  /* Operator only: measures for the journal (truth, noise floor, reference). Never shown. */
  operatorView?(results: readonly CaseResult[]): Record<string, unknown>;
}
```

**Como quedó implementado** (`lib/src/learn/objective.ts`). Hay tres ajustes respecto al esbozo:

- **`casesIn(place, context)`** recibe también el intento, el propósito (`check`, `validation`, `blind`), la posición
  del sitio entre los que se comprueban juntos y el conjunto ciego.
- **`run(model, casesPorSitio, context)`** corre varios sitios a la vez. Orbit lo necesita: estima el ruido juntando los
  sitios de un mismo conjunto. Devuelve los resultados por sitio y la vista del operador del conjunto.
- **`view(results, place)`** sustituye a `verdictOf`. Da los hechos que ve System 2 de un sitio: un veredicto por caso,
  agrupado como el mundo lo muestra (por episodio en orbit, por punto en `cells`). La regresión se muestra con
  `rerunView`, y `holds` la recibe como `{ before, now }`.

Y el protocolo, igual para cualquier objetivo, con sus parámetros:

```ts
interface Protocol {
  readonly places: { laboratory: Place; family: (index: number) => Place };   // worlds/*/family.ts
  readonly familySize: number;          // --family
  readonly validations: number;         // --validations
  readonly confirmSets: 2;              // two blind sets
  readonly confirmPlaces: number;       // --confirm-setups / --confirm-boards
  readonly pairedRegression: boolean;   // run the previous check's cases again with the new model
  readonly quick: boolean;              // --quick
}
```

### 3.1 Dos clases de tarea

| | Predecir (`use: 'predict'`) | Actuar (`use: 'act'`) |
|---|---|---|
| Qué hace la respuesta | se compara con lo que pasó | la usa un controlador (la búsqueda) para elegir acciones |
| Caso | un punto no visto | un episodio desde una salida no jugada |
| Veredicto | la desviación, normalizada, por componente | la puntuación del episodio |
| Ejemplo | orbit@1 | la cuadrícula |

Las dos comparten el protocolo y el artefacto (observaciones, reglas, pesos, `output`). Lo que cambia es `run`: comparar
o jugar.

### 3.2 La regresión emparejada, para todo objetivo

Hoy solo la cuadrícula vuelve a correr los casos de la comprobación anterior con el modelo nuevo (mismos casos, mismas
semillas). En orbit equivale a volver a predecir los puntos de la comprobación anterior. Con el contrato es un parámetro
del protocolo (`pairedRegression`), y "se sostiene" puede exigir que ningún caso vuelto a correr empeore (`previous` en
`holds`).

### 3.3 Se valida el modelo que se sostuvo

Si System 2 pide validar el mismo modelo (la misma huella, los mismos laboratorios) que se sostuvo en la última
comprobación, se valida sobre esa comprobación, sin comprobarlo otra vez. Una comprobación nueva puede fallar por azar
(§1.1), y entonces el modelo que se sostuvo no se validaría nunca. System 2 lo ve como `not_checked_again`, y la
interfaz común lo dice. Implementado en `run-grid.ts` y `run-orbit.ts` (`heldAt`).

## 4. Los dos mundos como instancias

| Pieza | orbit@1 (hoy en `run-orbit.ts`) | Cuadrícula (hoy en `run-grid.ts`) |
|---|---|---|
| Forma de la respuesta | el par que mostrará el último par de columnas en la fila siguiente | un número de 0 a 1 por punto |
| Lectura de la respuesta | `answerAsDeparture`: d = respuesta − 2·p(ahora) + p(antes) | la búsqueda la usa como valor |
| Casos | `launchesIn`: lanzamientos no vistos, en vista y más allá | `plansFor`: salida habitual + salidas no jugadas, con semilla |
| Veredicto por caso | `scoreOf`: tanh((obs − pred)/\|obs\|) por eje | puntuación del episodio (1, 0, −1) |
| Se sostiene | por banda, mediana de χ² ≤ `--accept`, con el ruido estimado de lo observable y la precisión declarada | todos los episodios puntúan 1 y ninguno vuelto a jugar baja |
| Familia | `environmentOf`: otras fuentes, otro marco | `boardOf`: otro tamaño, piezas y salidas |
| Confirmación ciega | dos conjuntos de montajes `blind*` (`blindPlaces`) | dos conjuntos de tableros `blind*` (`blindPlaces`) |
| Métricas del operador | ley oculta, suelo de ruido, prior newtoniano, calificación | techo informado, precisión de acción, calificación |

La implementación reproduce los dos comportamientos (§7, O1–O2): con un LLM falso y el juez plano, los checks dan las
mismas cifras que antes del cambio. Hoy viven en `lib/src/worlds/orbit/objective.ts` y `lib/src/worlds/grid/objective.ts`.
Las líneas de interfaz de la respuesta y del veredicto salen del objetivo, y el texto del prompt no cambió.

El tercer mundo, `cells@1` (O5), es una fila de símbolos cerrada en anillo con una regla local oculta:

- **Respuesta:** la fila siguiente, como texto (ni un número ni un par).
- **Casos:** puntos de episodios no vistos.
- **Veredicto:** las posiciones donde la respuesta difiere.
- **Se sostiene:** todos los puntos son exactos.
- **Familia:** otras longitudes y mezclas, con la misma regla.

## 5. Qué ve System 2 y qué no

**Ve:** la forma de la respuesta y la forma del veredicto (en la interfaz); sus sitios (`places`) y su papel; por
comprobación y por sitio, si su modelo se sostiene y el veredicto de cada caso; en la regresión emparejada, qué casos
cambiaron y hacia dónde; las validaciones que le quedan; si fue aceptado.

**No ve:** ningún estadístico sobre sus casos, la ley o las reglas ocultas, el umbral numérico de "se sostiene" más allá
de lo que la interfaz describa, las métricas del operador, las ablaciones, ni qué caso fue "el peor".

**Pregunta de diseño abierta (§9.1):** ¿debe la interfaz decir el criterio de "se sostiene"? Hoy no lo dice en ninguno de
los dos mundos: System 2 solo sabe si se sostiene. Decirlo sería transparencia sobre la métrica, no sobre el mundo, pero
también una invitación a optimizarla.

## 6. Métricas sin verdad calculable

En orbit y en la cuadrícula el veredicto se calcula: hay lo que pasó y hay un resultado de partida. Para tareas donde no
lo hay (un texto, un diseño, una decisión), el objetivo puede declarar una **rúbrica** del operador, y el veredicto lo
emite un juez:

- el juez ve la **respuesta** y la **rúbrica**, nunca el razonamiento de System 2 ni la verdad del operador;
- es un juez **distinto de Jev**: Jev juzga reglas sobre observaciones, este juzga respuestas contra la rúbrica;
- su veredicto por caso es un hecho más ("la rúbrica se cumple en estos criterios"), y "se sostiene" sigue siendo del
  operador;
- la confirmación ciega es aún más necesaria: un juez LLM se puede complacer.

Es una extensión, no la primera fase: primero los dos mundos con verdad calculable.

## 7. Plan

Cada fase reproduce primero el comportamiento actual (journals equivalentes en ensayos con LLM falso y juez neutro) antes
de añadir nada.

| Fase | Contenido | Ficheros | Estado |
|---|---|---|---|
| O1 | Tipos `Objective`, `Protocol`, `Place`; el bucle del protocolo en la biblioteca (comprobación, validación, laboratorios nuevos, confirmación ciega, `--quick`, reinicio para una etapa nueva) | `lib/src/learn/objective.ts`, `lib/src/learn/protocol.ts` | hecho |
| O2 | orbit@1 y la cuadrícula como instancias; los runners quedan en configuración, E/S, instrumentos y journal | `lib/src/worlds/*/objective.ts`, `lib/scripts/run-*.ts` | hecho |
| O3 | La regresión emparejada como parámetro, también en orbit (`--regression`; la ley debe seguir sosteniéndose en los puntos de la comprobación anterior) | `lib/src/learn/protocol.ts`, `lib/src/worlds/orbit/objective.ts` | hecho |
| O4 | Medidas del operador comunes en el journal (`operator_summary`): hitos, coste en total y hasta la aceptación, cuánto aportan las reglas de Jev en las ablaciones, evaluaciones sin preguntar a Jev, y comprobaciones que una línea base que no sabe nada también pasa (`check_is_trivial`; en `cells` y orbit, no en la cuadrícula, donde costaría partidas enteras) | `lib/src/learn/operator.ts`, `lib/src/learn/protocol.ts` | hecho |
| O5 | Un tercer entorno pequeño, conectado solo con mundo + sentidos + acciones + objetivo: `cells@1` | `lib/src/worlds/cells/`, `lib/scripts/run-cells.ts`, `lib/src/learn/law-session.ts` | hecho |
| Visor | Síntesis visual de un run terminado, construida a partir de su journal: momentos por relevancia, el camino al modelo final, linajes de creencias, comprobaciones por ronda; animaciones de lo que mostró el entorno y de lo que intentó el modelo caso a caso, y un modo de presentación. Para ello el journal guarda, solo para el operador, las lecturas de los episodios de exploración y una traza por lugar de cada comprobación (`Objective.trace`). No toca lo que ve System 2 | `lib/src/view/`, `lib/scripts/journal-view.ts`, `journal-viewer.html` | hecho |
| O6 (opcional) | Objetivos con rúbrica y juez (§6) | — | no empezado |
| O7 | Exportar la API de laboratorio por una entrada propia, `neurosym/lab` (objetivo, protocolo, sesión, prompt, modelo y predicción, medidas del operador); `grid`, `cells` y `messages` en los `exports` del paquete. El índice principal no cambia: es lo que embebe el bundle del harness del navegador (§10) | `lib/src/lab.ts`, `lib/src/worlds/*/index.ts`, `lib/package.json` | hecho |
| O8 | Desacoplar de orbit la sesión y el predictor. `LawSession<A>` y `parseLawTurn<A>` sin mundo por defecto: `parseAct` es obligatorio. La interfaz, los instrumentos y el acto de orbit pasan a `worlds/orbit/interface.ts`. `launchesLeft` pasa a `actsLeft` (System 2 ya leía `acts_left`). `Predictor<S, C>` compara la respuesta que declara el mundo (por defecto, la respuesta tal cual; orbit, un par). El prompt de orbit es idéntico byte a byte (§10) | `lib/src/learn/law-session.ts`, `lib/src/learn/law-explorer.ts`, `lib/src/core/predict.ts`, `lib/src/worlds/orbit/interface.ts` | hecho |
| O9 | Contrato `Lab` y un runner único. Un mundo se declara en un fichero (`worlds/<mundo>/lab.ts`: mundo y familia, sentidos, episodios y cómo se nombran sus puntos, acto y simulación opcionales, objetivo, y del operador la verdad, las líneas base y cuándo una respuesta coincide). `runtime/lab-runner.ts` hace el resto igual para todos, y `run-lab.ts --lab <id>` lo lanza. `run-cells.ts` y `run-messages.ts` quedan en 14 líneas (antes 397 y 367), y los lanzadores siguen igual. Equivalencia comprobada con un LLM falso: journals idénticos en messages; en cells solo se añaden `by_place` en la ablación y la densidad de cada lugar al final. Orbit y la cuadrícula siguen con runner propio (§10.3) | `lib/src/learn/lab.ts`, `lib/src/runtime/lab-runner.ts`, `lib/src/worlds/{cells,messages}/lab.ts`, `lib/scripts/run-lab.ts` | hecho (cells, messages) |
| O10 | El hallazgo como entregable: `findingOf(journal)` produce `finding@1`. Contiene la pregunta (forma de la respuesta y del veredicto), el resultado, el modelo con su fingerprint, las afirmaciones (creencias mantenidas con su evidencia), dónde se sostuvo al aceptarse (laboratorios, familia y lugares ciegos, sin la traza caso a caso), los contraejemplos (validaciones fallidas), las limitaciones (fallos tolerados, comprobaciones que pasa un modelo que no sabe nada, lo que System 2 dejó abierto), la parte del operador (nota del grader, ablación de Jev, verdad oculta), el coste y cómo reproducirlo (seed, config, journal, commit). También hay una versión en texto de pocas líneas. El runner de laboratorios lo escribe junto al journal (`<journal>.finding.json`) y guarda en el journal el commit (`+changes` si el árbol de trabajo tiene cambios) y el objetivo. `scripts/finding.ts <journal...>` lo obtiene de cualquier journal, también de runs anteriores de grid y orbit. System 2 no ve nada nuevo (§10) | `lib/src/learn/finding.ts`, `lib/scripts/finding.ts`, `lib/src/runtime/lab-runner.ts` | hecho |
| O11 | Ejecución reanudable: punto de control por ronda, cancelación y presupuesto de tiempo y tokens (resuelve la pregunta abierta 3) (§10) | `lib/src/learn/protocol.ts` | no empezado |

**Criterio de éxito de la SPEC:** O5 se conecta sin tocar el prompt ni el protocolo. **Cumplido.** `cells@1` usa el prompt
común, el protocolo y la sesión de System 2 tal cual. Del código común solo necesitó dos cosas generales:

- que los parámetros de `act` los lea cada mundo (`parseAct`);
- poder obtener la respuesta de un modelo sin la comparación numérica de orbit (`Predictor.rawAnswerWith`).

La sesión (`LawSession`: consultas, notebook, pasos de investigación, reflexión) salió de `run-orbit.ts` a la
biblioteca, y orbit la usa igual.

**Queda fuera de O5:** la cuadrícula conserva su propio bucle de consulta, porque su modelo es una fórmula que usa una
búsqueda y tiene instrumentos propios como `replay`. Unificarlo con `LawSession` es trabajo aparte.

## 8. Evidencia que la sostendría

- **Repetir** el run de orbit L1 (¿se repite la trayectoria: laboratorio → familia → superposición?).
- **Línea base** `--tools none`, mismo seed y presupuesto: ¿cuánto aportan los instrumentos?
- **La cuadrícula** con el protocolo (`--seed 22`), una tarea de actuar donde el código es torpe: ¿aporta Jev?
- **orbit a nivel 3 o 4** (término de velocidad, atracción que no es potencia): H2 de `SPEC-MUNDO-FISICO.md`, Jev
  debería ganar al código donde el código expresa mal.
- **H3 (`messages@1`)**: con Jev real y con `--flat`, mismo seed. ¿El modelo aceptado pregunta a Jev, y la ablación
  muestra que sus reglas aportan en la familia?
  - Primer run (seed 1, 27/09): se aceptó sin Jev, con regex. Para que el mundo discrimine:
    - vocabulario abierto en la confirmación ciega;
    - tolerancia 0 a ciegas;
    - verdad por regla (`factors` y `meaning` no deben mencionar la prisa si la regla no la usa);
    - que el grader no penalice distinciones que el mundo no produce, como un tono neutro.
- **O5**: `cells@1` con LLM real (`./run-cells.sh --seed 1 --level 1`, y `--level 2`): ¿recupera la regla desde cero y
  la valida en la familia? Es un mundo sin conocimiento previo útil tan claro como la mecánica. ¿Aporta Jev algo cuando
  la respuesta es una fila entera?

## 9. Preguntas abiertas

1. ¿La interfaz debe describir el criterio de "se sostiene" (§5)? Recomendado: no, de momento; que lo descubra como
   descubre el veredicto, y medir si pedir validación antes de tiempo se vuelve un problema.
2. ¿El veredicto debe poder ser más pobre (solo "acertó / falló" por caso) para tareas donde el veredicto detallado
   sea casi un gradiente? En orbit el signo por eje ya orienta la corrección; es un hecho, pero muy informativo.
3. ¿Un presupuesto común de coste (llamadas a Jev y al LLM) como parte del protocolo, con el coste por aceptación como
   medida principal del operador?
4. ~~Jev sin uso (§1): ¿se le sigue preguntando cuando el `output` no lee `m`?~~ **Resuelto:** no se le pregunta.
   - El `output` corre primero con `m.rules` y `m.V` perezosos (`OutputRunner.runIfJudgeUnread`). Si no los lee (ni
     dentro de un `try`, ni al esparcir `m`), su respuesta vale y Jev no se consulta. La respuesta es la misma en los
     dos casos.
   - `inspect` sí pregunta las reglas del paso elegido (`askRules`), para que System 2 vea qué responde Jev a sus reglas.
   - El journal cuenta las evaluaciones sin preguntar (`not_asked_output_ignores_rules`): es la medida de "reglas
     decorativas" de O4.
   - Habría evitado 877 llamadas en orbit y 6 739 en la cuadrícula.
5. Para tareas de actuar, ¿el objetivo puede pedir además un modelo del mundo (lo que G2 descartó en la cuadrícula por
   filtrar la forma del entorno)? Recomendado: no; el objetivo pide una sola respuesta.
6. **El criterio "se sostiene" frente al ruido (§1.1).** Todo o nada sobre pocos casos castiga a un modelo bueno por
   azar y empuja a parchear casos sueltos. Opciones, todas del operador:
   - **(a) Un umbral:** por ejemplo, perder ≤ 1 de 8 y que ningún caso vuelto a correr empeore.
   - **(b) Solo cuentan los fallos evitables:** la cuadrícula tiene solver (`critical`: la jugada que tiró una victoria).
     Una derrota desde una salida perdida no cuenta. No filtra nada: System 2 solo ve "se sostiene".
   - **(c) Más casos por comprobación.** Cuesta más, y no resuelve el todo o nada.
   - **(d) Un intervalo:** que la tasa de acierto supere un umbral con confianza, lo que cambia el criterio de "todos"
     a "casi todos".

   §3.3 ya evita el peor caso (no validar un modelo que se sostuvo). Recomendado: (b) donde haya solver y (a) donde no.
   Pendiente de decidir.

## 10. Auditoría externa (28/09/2026): valoración e incorporación

### 10.1 Qué dice

La auditoría considera que la parte genérica ya es real en el protocolo (`Objective`, laboratorios, validación,
regresión, confirmación ciega, notebook, sesión) y solo parcial en la integración.

Hoy es un núcleo reutilizable con adaptadores de dominio escritos a mano. Su siguiente salto no consiste en añadir más
mundos, sino en dos cosas:

- que un laboratorio nuevo se conecte mediante un contrato pequeño;
- que entregue evidencia reutilizable a un agente que lo invoque. Por ejemplo, un coordinador que convierte una
  incertidumbre en una pregunta comprobable, deja que el arnés la investigue y usa el resultado.

### 10.2 Contraste con el código

Todas las señales de acoplamiento se confirman:

- **Tamaño de los runners:**

  | Runner | Líneas |
  |---|---|
  | `run-messages.ts` | 367 |
  | `run-cells.ts` | 397 |
  | `run-orbit.ts` | 613 |
  | `run-grid.ts` | 865 |

  Mezclan configuración, instrumentos, journal y ejecución.
- **`LawSession` sigue atada a orbit:** su parámetro de tipo por defecto es `OrbitAct` y el presupuesto se llama
  `launchesLeft`.
- **El predictor convierte a `Vec2`:** `rawAnswerWith` fue el parche para `cells`.
- **Lo nuevo no se exporta:** `learn/index.ts` no exporta `objective`, `protocol`, `law-session`, `prompt` ni
  `operator`, y el paquete solo expone `foxhounds` y `orbit`.

### 10.3 Qué se incorpora (fases O7–O11 de §7)

- **O7 y O8. Exportar y desacoplar.**
  - Son baratas y no tocan lo que ve System 2.
  - `launchesLeft` pasa a ser un nombre que declara el mundo en su `WorldInterface`, de modo que el prompt de orbit
    queda idéntico.
  - Criterio: journals equivalentes en ensayos con LLM falso, como en O1–O5.
- **O9. El contrato `Lab`.**
  - Es la continuación natural del criterio de O5: un mundo se conecta con mundo, sentidos, actos y objetivo.
  - Un `Lab` reúne en una definición declarativa:
    - mundo, sentidos, actos (`parseAct`) y objetivo;
    - la familia (`placeOf(index)`);
    - los instrumentos que ofrece;
    - los presupuestos por defecto;
    - la verdad del operador, que es opcional (un laboratorio real no la tiene).
  - Criterio de éxito: `messages` y `cells` corren con `run-lab.ts` sin runner propio.
  - La cuadrícula va al final, porque conserva su propio bucle (§7, "queda fuera de O5").
- **O10. El hallazgo como entregable.** Encaja de lleno con el objetivo de interpretabilidad. `finding.json` contiene:
  - la pregunta, que es el objetivo;
  - el modelo final, con su fingerprint;
  - dónde se sostuvo: los lugares con su rol y la variación de la familia;
  - evidencia y contraejemplos: las creencias con sus referencias y los lugares que fallaron y por qué;
  - las limitaciones conocidas, de la reflexión y de los fallos tolerados. Dos ejemplos:
    - "a pair of" en la confirmación ciega de `messages@1`;
    - el paso 0 no identificado en `cells@1`;
  - el coste;
  - cómo reproducirlo: seed, config y commit.

  Lo deriva el operador desde el journal. System 2 no ve nada nuevo. El visor puede leerlo.
- **O11. Ejecución reanudable.**
  - Incluye un punto de control por ronda, cancelación y un presupuesto de tiempo y tokens.
  - El servicio completo (iniciar, consultar, cancelar y reanudar para otros agentes) se deja hasta que haya un
    consumidor.
- **Invariante nuevo: quien diseña el laboratorio no evalúa.**
  - Hoy ya se cumple: System 2 nunca toca el criterio ni los lugares ciegos.
  - Cuando un agente monte laboratorios, el criterio, la familia y la semilla de los lugares ciegos quedarán fijados
    antes del primer turno de System 2.
  - Su hash irá en el journal (`start`), para que nadie pueda relajar el criterio sin que se note.

### 10.4 Qué queda como horizonte, y por qué

- **Coordinación de varios laboratorios y composición.**
  - Validar las piezas por separado no valida su composición.
  - Cada hallazgo tendrá que llevar sus condiciones de aplicación (O10 las prepara).
  - Se aborda después de O9 y O10.
- **Primer laboratorio no sintético.**
  - La auditoría da un encaje alto a descubrir el comportamiento de una API o protocolo local.
  - Es el candidato natural tras O9, porque pondría a prueba el contrato con una verdad que no es nuestra.
- **Modo herramienta (conocimiento previo, estimadores, análisis especializados).**
  - La auditoría tiene razón en que ocultar estadísticas y orientación de dominio es una elección del experimento, no
    un requisito universal.
  - Pero en este proyecto esa elección es la tesis: el entorno solo da su veredicto, System 2 aprende de fuentes
    propias y no hay investigación precocinada.
  - Si se hace, será un modo separado, marcado en el journal y nunca comparado con los runs del modo experimento.
  - Decisión del autor. No se implementa ahora.

### 10.5 Matiz a la auditoría

- **En ingeniería, estamos de acuerdo:** la genericidad ya no depende de más mundos.
- **Para la tesis sí falta uno:** un mundo donde leer por significado (Jev) sea necesario.
  - Los tres mundos de los runs recientes se resolvieron solo con código.
  - En `messages@1` fue así porque el vocabulario es cerrado y los laboratorios lo muestran casi entero.
- Esa línea sigue en §8:
  - vocabulario abierto en la confirmación ciega;
  - tolerancia 0 en la confirmación a ciegas;
  - verdad por regla, sin mencionar factores que la regla no usa.
