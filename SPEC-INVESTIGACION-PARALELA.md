# SPEC · Investigación en paralelo: varios mundos de una familia a la vez, con intercambio

Estado (04/10/2026): **propuesta, sin implementar.** Pregunta abierta del autor, con una evaluación externa incorporada.

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
  de la experiencia (SPEC-INVESTIGADOR-ASISTIDO §12.1). Sus runs no se comparan con los de la condición individual
  (P6/Q7) salvo en el diseño de §6, hecho para eso.

El coste total puede subir (coordinación, trabajo duplicado, más comprobaciones) o bajar (un resultado negativo
compartido ahorra a los demás el mismo callejón). Cuál de las dos cosas pasa es una pregunta empírica (§6), no un
supuesto.

## 2. Lo que ya existe y en qué se apoya

| pieza | dónde | qué aporta aquí |
|---|---|---|
| **Familia de mundos** | protocolo (SPEC-OBJETIVO §3), `worlds/*/family.ts` (`boardOf` en la cuadrícula: otro tamaño, otras piezas, otras salidas) | mundos que comparten la ley y cambian los parámetros locales |
| **Validación y confirmación ciega** | protocolo: lugares `family` y conjuntos `blind*`, nunca vistos antes de su comprobación | los mundos que **no** se pueden explorar: son el examen |
| **Lugares en una petición** | los mundos de leyes ya aceptan `place` en `act` | un experimento puede ya dirigirse a un lugar concreto |
| **Lector de registros** | `learn/assisted/record.ts` (`journalReader`), `experience.ts` | leer lo que otro investigador vio y escribió, sólo su vista |
| **Orquestador y ramas** | SPEC-ORQUESTADOR §4, §5.5, R2–R3b (`batch.ts`, `project.ts`) | lanzar runs en paralelo, bifurcar una historia, seguirlas |
| **Senior** | SPEC-ORQUESTADOR §3.3 | un coordinador con procedencia, que guía sin hacer el trabajo |
| **Grabación y reanudación** | `ReplayLog`, `--resume` | todo lo que entra en un run se graba, y un run se reanuda igual |
| **Auditoría del método** | `audit/` (MA1, MA3) | medir duplicación, uso de resultados ajenos y convergencia prematura |

Lo que **falta**:

- un conjunto de mundos de exploración separado de los de validación y confirmación;
- un canal de intercambio **vivo** (hoy la experiencia sólo lee runs terminados);
- un tipo de lote "equipo" en el orquestador.

## 3. Principios

- **E1. Los mundos de examen nadie los explora.**
  - Los mundos de exploración salen de índices de la familia **disjuntos** de los de validación y de los conjuntos ciegos.
  - Lo que el equipo explora en común pasa a ser parte de la búsqueda, y la generalización se examina en mundos que nadie
    del equipo vio.
  - El journal registra qué índices exploró cada miembro, y el protocolo rechaza validar en uno de ellos.
- **E2. Lo compartido es evidencia con procedencia, no conclusión.**
  - Una entrada compartida dice: hipótesis, mundo, intervención, resultado observado y alcance de lo que concluye.
  - Lo que opina un compañero es una hipótesis para quien lo lee, igual que una fuente o una experiencia (P4: decide el
    mundo).
  - Se cita como `peer:<miembro>#<entrada>`, y el finding lo separa (`grounded: peer`).
- **E3. Ley común frente a parámetros locales.**
  - Dos mundos de la familia comparten estructura y difieren en tamaño, piezas, salidas, masas, fuentes...
  - Toda entrada lleva el mundo en que se observó.
  - Pasar un parámetro local como universal es un error que la auditoría puede marcar (J4, alcance demasiado amplio).
- **E4. Independencia antes de comunicar.**
  - Compartir cada pensamiento al instante hace que todos converjan pronto sobre el mismo error.
  - El intercambio se abre por **ventanas** (cada k rondas) y lo que se publica lo **elige el investigador**: nada se
    comparte solo.
- **E5. Trabajo complementario, decidido arriba.**
  - El reparto de papeles (identificar la ley, intentar refutarla, buscar dónde falla) lo fija el operador o el
    planificador con `--task` por miembro.
  - El equipo no se lo reparte en el canal.
- **E6. El puro sigue puro.**
  - Sólo el asistido participa en un equipo, igual que con fuentes y experiencia.
  - Un puro puede ser miembro "independiente" (condición 2 de §6), pero nunca lee el canal.
- **E7. Todo se graba y se reanuda.**
  - Cada lectura del canal pasa por el log de grabación del run (canal `peer`): un run reanudado lee lo mismo que leyó,
    aunque los compañeros hayan seguido escribiendo.
- **E8. Presupuesto común y declarado.**
  - El equipo tiene un presupuesto total B (tokens, tiempo, llamadas a Jev), repartido entre miembros.
  - El coste de coordinar (planificador, senior) cuenta dentro de B.

## 4. Modalidad A: un investigador, varios mundos de exploración

**Qué se reparte:** los experimentos. **Qué aporta:** más evidencia por paso, con una sola línea de razonamiento.

- El run recibe `--explore-places k`: k mundos de exploración de la familia (índices disjuntos, E1), además del mundo base.
- El investigador ve sus lugares en la interfaz (como hoy ve sus laboratorios) y dirige cada petición a uno: `view`,
  `act`, `replay` y `table` llevan `place`.
- Las peticiones de un mismo paso a lugares distintos se ejecutan **a la vez**. El paso sigue contando como un paso: el
  presupuesto en pasos no cambia, cambia cuánta evidencia cabe en él.
- El uso natural es el que propone la evaluación externa:
  1. plantear varias explicaciones incompatibles;
  2. encargar pruebas que las discriminen en mundos distintos;
  3. recibir los resultados juntos y actualizar.
- **Lo que cambia para el investigador:**
  - el prompt del asistido gana una línea genérica sobre los lugares y el campo `place`;
  - el puro no lo tiene (E6).

**Por qué empezar por aquí:**

- mide el valor de la variación entre mundos sin la complejidad de coordinar investigadores;
- ataca directamente la confusión entre ley y parámetro (E3): ver tres tableros a la vez obliga a separar lo que cambia de
  lo que no;
- el coste extra es pequeño (§7).

## 5. Modalidad B: varios investigadores, varios mundos, un canal

**Qué se reparte:** hipótesis, estrategias y experimentos. **Qué aporta:** caminos alternativos explorados a la vez.

### 5.1 El equipo

- Un lote del orquestador de tipo **equipo** (`team@1`) declara:
  - los miembros, cada uno con su modelo, su mundo de exploración (E1) y su papel (`--task`, E5);
  - la ventana de intercambio (cada cuántas rondas se abre el canal);
  - el presupuesto común (E8) y los mundos de examen reservados.
- Cada miembro es un run normal con su journal; el equipo tiene además el suyo, con las publicaciones, las ventanas y el
  criterio de parada.
- Encaja con las ramas de SPEC-ORQUESTADOR §5.5: una rama puede seguir refinando el modelo actual mientras otra recupera
  un modelo anterior y explora la alternativa. Es justo el backtracking que en la continuación grid-s22 un solo
  investigador tuvo que hacer en serie, rejugando el modelo de la ronda 8 entre sus propias rondas.

### 5.2 El canal (tablón)

- **Publicar.** Un miembro publica con una petición propia, por ejemplo
  `{"publish": {"claim", "kind": "result" | "dead_end" | "method", "world", "intervention", "observed", "scope", "evidence"}}`.
  Sólo lo que publica sale de su run: ni su cuaderno ni sus creencias se comparten por defecto (E4).
- **Leer.** Durante una ventana, el miembro lee el tablón con las primitivas de siempre: `{"peers": "list" | "open" |
  "find", ...}`. Usa el mismo lector que la experiencia (`list`, `open`, `find`, `select` con Jev) y cada lectura cuenta
  como un paso.
- **Los callejones sin salida son de primera clase** (`kind: "dead_end"`): qué se probó, dónde, qué salió y por qué se
  descarta. Es la entrada que más trabajo ahorra a los demás.
- **Procedencia y aislamiento:**
  - lo publicado es la vista del investigador, nunca la del operador;
  - la lectura se graba en el log (E7);
  - las citas `peer:` llegan al finding.

### 5.3 Coordinación

- **Sin coordinador:** cada miembro lee el tablón en las ventanas y decide solo.
- **Con senior:** un senior por equipo lee el tablón y los registros, y escribe a cada miembro su siguiente hipótesis o
  tarea, con evidencia (§3.3 del orquestador). No hace el trabajo de los miembros.
- **Con planificador:** abre y cierra ramas, reasigna presupuesto y decide cuándo para el equipo. Decide por un criterio
  computable sobre los findings (Q3): por ejemplo, el primer modelo validado en los mundos reservados.

## 6. Cómo saber si sirve: tres condiciones con el mismo presupuesto

Es la propuesta de la evaluación externa, que separa el beneficio de **explorar más ramas** del beneficio de
**intercambiar**:

| condición | qué es |
|---|---|
| **1. Solo** | un investigador con presupuesto total B |
| **2. Independientes** | N investigadores sin canal, B/N cada uno; el equipo resuelve si uno resuelve |
| **3. Comunicados** | N investigadores con canal y ventanas, B/N cada uno (más la coordinación, dentro de B) |

Y, para la modalidad A:

| condición | qué es |
|---|---|
| **A0** | un investigador, un mundo de exploración |
| **Ak** | un investigador, k mundos de exploración, mismos pasos |

**Medidas:**

- **Éxito:** modelo validado en los mundos reservados; RR cuando hay verdad, como lectura del operador.
- **Tiempo:** hasta una solución validada, en reloj y en rondas.
- **Coste total:** tokens, dólares y llamadas a Jev, incluida la coordinación.
- **Duplicación:** experimentos equivalentes hechos por más de un miembro. Se mide con la auditoría del método (O4,
  agrupando por intervención y mundo).
- **Callejones evitados:** lecturas de entradas `dead_end` seguidas de no repetir esa intervención.
- **Convergencia prematura:** diversidad de hipótesis vivas entre miembros a lo largo de las rondas. Si cae a una sola
  antes de validar y esa falla, el canal ha hecho daño.
- **Método:** la auditoría (SPEC-AUDITORIA-METODO) de cada miembro, para ver si el canal mejora o empeora el encadenado,
  por ejemplo si se lee como hecho lo que era hipótesis de otro.

**Lectura:**

- 2 frente a 1 es el valor de explorar más ramas.
- 3 frente a 2 es el valor del intercambio.
- Ak frente a A0 es el valor de la variación simultánea entre mundos.
- Con réplicas (seeds), porque la varianza entre runs es grande: la continuación grid-s22 osciló entre 3/8 y 8/8.

## 7. Coste

Cifras medidas en los runs de la cuadrícula (02–03/10, Luna, 8 rondas):

- **Investigador:** ~$0.08 por run (52 % de la entrada en caché); con senior Sol, ~$0.33.
- **Sol solo:** $1.29.
- **Qwen local:** 0 $.
- **Reloj:** 110–340 s por ronda.
- **Jev en los checks:** 10.000–44.000 llamadas por run.

**Modalidad A (k mundos de exploración):**

- **LLM:** los mismos pasos y las mismas llamadas, pero respuestas más largas. Ver tres tableros en vez de uno multiplica
  el resultado de un paso (hoy 2–4 KB por `view`). Con k = 3, se estima entre +30 % y +80 % de tokens de entrada: con Luna,
  de $0.08 a ~$0.10–0.14 por run.
- **Jev:** no cambia. La exploración no usa Jev y los checks son los mismos.
- **Reloj:** sin cambio apreciable. Los mundos se simulan en local y las peticiones de un paso corren a la vez.

**Modalidad B (N miembros, canal):**

| | condición 1 (solo) | condición 2 (N independientes) | condición 3 (N comunicados) |
|---|---|---|---|
| LLM | B | B (por diseño) | B + lecturas del tablón + coordinación |
| Jev | checks de 1 run | **N × checks** | **N × checks** |
| Reloj hasta resolver | R rondas × ~110–340 s | ~R/N si las ramas son independientes y una acierta | menos que 2 si el canal evita callejones |

- **El coste oculto es Jev.**
  - Cada miembro hace sus propios checks y validaciones, y los checks son la parte cara en llamadas: miles por ronda.
  - Con N = 3, el uso de Jev se triplica aunque los tokens del LLM se mantengan en B.
  - Para acotarlo: limitar los checks por miembro, o que sólo valide el modelo que el equipo elija. Esto es pregunta
    abierta (§9).
- **Las lecturas del tablón** cuestan como la experiencia: un paso y unos 2–5k tokens por lectura. Con ventanas cada 3
  rondas y 2 lecturas por ventana, +5–10 % de tokens por miembro.
- **La coordinación con senior Sol** son ~$0.25 por run seguido, como hoy. Un senior para todo el equipo cuesta menos que
  uno por miembro y encaja mejor con E5.
- **Ejemplo: tres Lunas comunicadas con un senior Sol.**
  - LLM: ≈ 3 × $0.08 + $0.25 + lecturas ≈ **$0.50–0.55**, frente a $0.33 de una Luna con senior.
  - Jev: unas 3 × 10.000–44.000 llamadas.
  - A cambio, hasta tres ramas a la vez en el mismo reloj.
- **Lo que puede bajar el coste:**
  - un `dead_end` leído a tiempo evita rondas enteras a los demás (en la continuación, unas 5 rondas fueron variaciones
    de la misma idea de movimiento);
  - un modelo validado antes corta el presupuesto restante de todos los miembros.

## 8. Plan

- **PA1 · Mundos de exploración.** Índices de la familia disjuntos de validación y ciegos (E1); `--explore-places k`;
  `place` en las peticiones de la cuadrícula; registro en el journal.
- **PA2 · Modalidad A en el asistido.** La línea genérica del prompt, la ejecución concurrente de un paso y la
  experiencia A0 frente a Ak con réplicas.
- **PB1 · El tablón.** `publish` y `peers` (list/open/find/select) sobre un almacén del equipo; lecturas grabadas en el log
  (E7); citas `peer:` en el finding.
- **PB2 · El lote equipo.** `team@1` en el orquestador: miembros, papeles, ventanas, presupuesto común y mundos reservados;
  journal del equipo.
- **PB3 · Las tres condiciones de §6** con réplicas, y su tabla (éxito, tiempo, coste, duplicación, callejones evitados,
  convergencia).
- **PB4 · Auditoría del método para equipos.** Duplicación entre miembros, uso de entradas ajenas (J3 sobre citas
  `peer:`), convergencia.

PA1 y PA2 tienen valor por sí solas y no dependen del resto.

## 9. Preguntas abiertas

- **Checks compartidos:**
  - ¿Cada miembro comprueba su modelo, o el equipo propone uno y se comprueba una vez? Lo segundo ahorra Jev pero acopla
    a los miembros.
  - Una vía intermedia: checks propios con menos episodios, y la validación sólo para el candidato del equipo.
- **¿Qué se puede publicar?**
  - ¿Sólo resultados, o también métodos (`kind: "method"`)? Los métodos se parecen a la experiencia en alcance `methods`
    y casi no arrastran parámetros locales (E3).
- **Ventanas fijas o pedidas.** ¿El canal se abre cada k rondas, o un miembro puede pedir leerlo cuando lo necesita, con
  un coste en pasos? Lo segundo es más natural, pero erosiona la independencia (E4).
- **Mismo mundo o mundos distintos por miembro.**
  - Con el mismo mundo base, las ramas compiten por la misma ley con distintas ideas.
  - Con mundos distintos de la familia, cada uno ve variación propia y el canal transmite qué es común (E3).
  - Probablemente lo segundo para la ley y lo primero para el backtracking.
- **Qwen local en paralelo.** Con vLLM en una sola GPU, N miembros compiten por el mismo servidor: el reloj no se divide
  por N. Hay que medir el rendimiento con concurrencia antes de prometer aceleración.
- **¿El tablón puede contaminar el método?** Un miembro que adopta sin probar la conclusión de otro es justo lo que la
  auditoría debería marcar (J3, sobreinterpretación). Es otra razón para auditar a los equipos.
