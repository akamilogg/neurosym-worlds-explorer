# SPEC · El objetivo: la métrica de progreso que define el operador

**Fichero:** `SPEC-OBJETIVO.md`
**Estado (27/09/2026):** propuesta; el contrato está sin implementar. Parte del primer run real de orbit@1 con el prompt
común y el artefacto con `output` (§1) y del de la cuadrícula `--seed 22` (§1.1). Ya implementado, en los dos runners:
Jev solo se pregunta si el `output` lee las reglas (§9.4) y un modelo que se sostuvo se valida sin comprobarlo otra vez
(§3.3). Generaliza lo que hoy está repartido entre `lib/scripts/run-orbit.ts` y
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
| Se sostiene | `heldIn`: por banda, mediana de χ² ≤ `--accept`, con el ruido estimado de lo observable y la precisión declarada | todos los episodios puntúan 1 y ninguno vuelto a jugar baja (`checkIn`) |
| Familia | `environmentOf`: otras fuentes, otro marco | `boardOf`: otro tamaño, piezas y salidas |
| Confirmación ciega | `confirmBlind` | tableros `blind*` en el bucle del protocolo |
| Métricas del operador | ley oculta, suelo de ruido, prior newtoniano, calificación | techo informado, precisión de acción, calificación |

La implementación del contrato debe reproducir estos dos comportamientos **sin cambiarlos** (§7, O1–O2).

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

| Fase | Contenido | Ficheros |
|---|---|---|
| O1 | Tipos `Objective`, `Protocol`, `Place`; el bucle del protocolo en la biblioteca (comprobación, validación, laboratorios nuevos, confirmación ciega, `--quick`) | `lib/src/learn/objective.ts`, `lib/src/learn/protocol.ts` |
| O2 | orbit@1 y la cuadrícula como instancias; los runners quedan en configuración, E/S y journal | `lib/src/worlds/*/objective.ts`, `lib/scripts/run-*.ts` |
| O3 | La regresión emparejada como parámetro, también en orbit | `lib/src/learn/protocol.ts` |
| O4 | Medidas del operador comunes en el journal: cuánto aporta Jev (ablaciones, `output` que no lee `m`), coste por aceptación, rondas hasta validar | `lib/src/learn/protocol.ts` |
| O5 | Un tercer entorno pequeño, no diseñado pensando en estos dos, conectado solo con mundo + sentidos + acciones + objetivo | `lib/src/worlds/<nuevo>/` |
| O6 (opcional) | Objetivos con rúbrica y juez (§6) | — |

**Criterio de éxito de la SPEC:** O5 se conecta sin tocar el prompt ni el protocolo.

## 8. Evidencia que la sostendría

- **Repetir** el run de orbit L1 (¿se repite la trayectoria: laboratorio → familia → superposición?).
- **Línea base** `--tools none`, mismo seed y presupuesto: ¿cuánto aportan los instrumentos?
- **La cuadrícula** con el protocolo (`--seed 22`), una tarea de actuar donde el código es torpe: ¿aporta Jev?
- **orbit a nivel 3 o 4** (término de velocidad, atracción que no es potencia): H2 de `SPEC-MUNDO-FISICO.md`, Jev
  debería ganar al código donde el código expresa mal.
- **O5**: un entorno nuevo resuelto con el mismo prompt y protocolo.

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
