# SPEC · Agentes operadores, orquestador y planificador de proyectos

Estado (29/09/2026): **propuesto, sin empezar**. Es un spec futuro.

Parte de lo que ya existe tras SPEC-OBJETIVO (O7–O14) y SPEC-INVESTIGADOR-ASISTIDO (A1–A6):

- `runLaboratory(lab, opciones)`: un run como llamada de biblioteca, con presupuestos (`--max-tokens`, `--max-minutes`) y
  cancelación;
- la API de control (`runtime/control.ts`): lanzar, listar, seguir, parar y reanudar runs, y enviar órdenes (`message`,
  `focus`, `source`) con su autor (`by`) y su acuse;
- los dos investigadores, el de mundo desconocido (puro) y el asistido, y la política del operador para elegir uno;
- el finding en dos vistas: la del operador (con la verdad oculta y sus medidas) y la del investigador (lo observable);
- la grabación y la reanudación con procedencia.

## 1. Motivación

Hoy una persona hace de operador: decide qué experimentos lanzar, los sigue, ayuda al asistido cuando se atasca, lee los
findings, saca conclusiones y decide el siguiente paso. Este documento propone que ese papel lo pueda hacer, en parte o
entero, un agente. Hay tres niveles, cada uno sobre el anterior:

1. **Agente operador.** Un agente sigue un run asistido y hace lo que haría una persona: mandar mensajes, cambiar el foco,
   permitir orígenes de fuentes, parar.
2. **Orquestador.** Un agente lanza y gobierna varios runs a la vez: réplicas con otras seeds, condiciones distintas, los
   dos investigadores. Después compara sus findings.
3. **Planificador de proyecto.** Un agente persigue un **objetivo grande** en bucle, hasta cumplirlo o agotar el presupuesto
   de tiempo o de tokens: planifica ensayos, los lanza con el orquestador, sintetiza los resultados, fija objetivos nuevos,
   formula hipótesis y vuelve a empezar.

## 2. Principios

- **Q1. Los agentes usan la misma API que una persona.**
  - Sin atajos: la API de control, `runLaboratory` y los findings.
  - Todo lo que hace un agente lo podría haber hecho el operador humano, y queda igual de registrado.
- **Q2. Un agente nunca ve más que el investigador al que ayuda.**
  - Un agente que manda mensajes a un investigador lee sólo la **vista del investigador** de los findings (O14), nunca la del
    operador. Si no, la verdad oculta se filtraría por los mensajes.
  - Para el planificador vale lo mismo en cuanto sus decisiones lleguen a un investigador (mensajes, fuentes, objetivos).
  - La vista del operador (verdad oculta, ablaciones, líneas base) sólo la lee quien audita, y un auditor no ayuda.
- **Q3. El criterio no cambia: decide el mundo (P4).**
  - Ni un agente ni una síntesis hacen que un modelo se sostenga.
  - Que el objetivo grande se ha cumplido lo decide una **comprobación computable** sobre los findings, no la opinión del
    planificador.
- **Q4. El puro sigue puro (P1).** Un agente puede lanzar, parar y reanudar runs del puro, porque es control. No puede
  ayudarle: la política ya rechaza y registra mensajes, foco y fuentes.
- **Q5. Todo deja rastro y se puede reanudar.**
  - Cada decisión de un agente queda en un journal propio con su motivo, y cada orden lleva su autor (`by: "agent:<id>"`).
  - Las llamadas del agente a su LLM pasan por la grabación (un canal propio), así que un proyecto cortado se reanuda y
    decide lo mismo hasta el corte.
- **Q6. Los resultados son referencias, no verdades.**
  - Una síntesis es una aproximación, como cualquier fuente: se puede refutar con experimentos nuevos.
  - El planificador marca qué conclusiones ha replicado y cuáles se apoyan en un solo run.
  - Una conclusión contradicha por un experimento posterior se revisa, no se defiende.
- **Q7. Comparaciones legítimas (P6).** Sólo dentro del mismo investigador, o entre condiciones declaradas de antemano.
- **Q8. Presupuestos jerárquicos.** El proyecto tiene un presupuesto (tokens, tiempo, llamadas a Jev). Cada run recibe una
  parte y el planificador no puede gastar más de lo que le queda. El coste de sus propias llamadas también cuenta.
- **Q9. El humano manda.** El operador elige el grado de autonomía y puede parar, corregir o aprobar en cualquier momento.

## 3. Nivel 1: el agente operador

- **Qué hace:** sigue un run asistido (`watch`) y, cuando lo cree útil, envía órdenes: `message`, `focus`, `source` y `stop`.
- **Qué ve:** el journal en curso tal como lo ve la consola, y la vista del investigador de los findings (Q2). Nunca
  `hidden_from_the_learner` ni las medidas del operador.
- **Política de agentes** (amplía la política de investigadores, pregunta abierta 2 de SPEC-INVESTIGADOR-ASISTIDO):
  - qué agentes pueden enviar qué órdenes a qué runs, por ejemplo `agent:coach=message,focus`;
  - un **presupuesto de ayuda** por run (mensajes por ronda o en total), visible en el finding;
  - las órdenes de un agente fuera de su política se rechazan y se registran, como hoy las del puro.
- **Cuándo interviene:** lo decide el agente, a partir de lo que ve en el run: rondas sin avance, validaciones fallidas
  repetidas, peticiones de investigación que se repiten. El arnés no le da un diagnóstico hecho: le da el journal.
- **En el finding:** `assistance` ya separa las ayudas por autor; se añade si el autor era una persona o un agente.

## 4. Nivel 2: el orquestador

- **Un lote** es una lista de runs declarada de antemano, cada uno con su laboratorio, sus argumentos, su investigador y la
  condición que representa. Por ejemplo, cells nivel 4 con seeds 1 a 5, el puro con `--focus even` frente al asistido con
  `--focus even --task ...`.
- **Ejecución:**
  - lanza los runs con `startRun` o `runLaboratory`, con concurrencia limitada por los límites de las APIs;
  - reparte el presupuesto entre ellos;
  - los sigue; puede parar uno que se ha disparado de coste y reanudar los cortados.
- **Comparación:** una tabla por condición, hecha **sólo** con campos del finding:
  - aceptación y en qué ronda;
  - coste hasta aceptar;
  - dónde se sostuvo y dónde falló;
  - ayudas recibidas.
  - Réplicas: mediana y dispersión, no un run suelto.
- **Salida:** un informe de lote (`batch@1`) con la definición, los runs (enlaces a sus journals y findings) y la tabla.
  Reanudable: un run ya terminado no se repite.
- La vista del operador puede entrar en el informe como **auditoría aparte**, marcada como tal, y nunca vuelve a ningún
  investigador.

## 5. Nivel 3: el planificador de proyecto

### 5.1 El objetivo grande

Lo define el operador, en palabras y con un **criterio computable**:

- "Un modelo aceptado para cada nivel de cells, con el puro."
- "La ley de orbit, aceptada en tres seeds distintas, y que se sostenga con `--vary-strength`."
- "Saber si los mensajes del operador bajan el coste en la cuadrícula: al menos cinco pares de runs por condición."

El criterio se evalúa sobre los findings y los informes de lote. Si el objetivo no admite un criterio computable, el
planificador puede proponer uno, pero lo aprueba el operador antes de empezar.

### 5.2 El bucle

1. **Estado.** Qué se sabe hasta ahora: conclusiones con su respaldo (qué runs, cuántas réplicas), preguntas abiertas y
   presupuesto restante.
2. **Hipótesis.** Qué cree el planificador y qué experimento lo distinguiría. Cada hipótesis lleva su **predicción**: qué
   esperaría ver si es cierta y qué si no.
3. **Plan.** Un lote para el orquestador, con su presupuesto y la condición que prueba cada run.
4. **Ejecución.** El orquestador lanza el lote. El planificador puede actuar de agente operador en los runs asistidos, si
   la política se lo permite.
5. **Síntesis.** Contrasta los resultados con las predicciones: confirmada, refutada o sin decidir. Actualiza las
   conclusiones y marca las que dependen de un solo run.
6. **Objetivos nuevos.** Replicar lo dudoso, afinar lo prometedor, abandonar lo refutado, subir de nivel.
7. **Parada:**
   - el criterio del objetivo grande se cumple;
   - se agota el presupuesto (tokens, tiempo, llamadas);
   - no hay ninguna hipótesis nueva que valga su coste;
   - o el operador lo para.

### 5.3 El journal del proyecto (`project@1`)

- El objetivo y su criterio, la política, el presupuesto y lo gastado.
- Por iteración: el estado, las hipótesis con sus predicciones, el plan, los lotes (enlaces), la síntesis y las decisiones,
  cada una con su motivo.
- Las conclusiones vigentes, cada una con su respaldo y su historia (cuándo se propuso, se confirmó o se refutó).
- Al final, un **informe del proyecto**: qué se preguntó, qué se hizo, qué se sabe y con qué respaldo, qué queda abierto
  y cuánto costó. Legible por una persona (criterio de interpretabilidad del proyecto).

### 5.4 Grados de autonomía

- **Consultivo:** el planificador propone cada lote y el operador lo aprueba o lo corrige.
- **Con umbrales:** actúa solo mientras cada lote cueste menos de un umbral; por encima, pide aprobación.
- **Autónomo:** actúa solo hasta el criterio o el presupuesto; el operador puede pararlo o corregirlo en cualquier
  momento (Q9).

## 6. Interfaces

- **Biblioteca:** `runBatch(definición, opciones)` y `runProject(objetivo, opciones)`, como `runLaboratory`: sin variables
  de entorno, cancelables, con presupuesto, reanudables.
- **Línea de órdenes:**
  - `lab batch <fichero>` y `lab project start|status|approve|stop|resume`;
  - `lab send` y el resto siguen valiendo para los runs de un lote.
- **Consola:**
  - una vista de proyecto: objetivo, iteraciones, hipótesis y su estado, lotes, conclusiones, presupuesto;
  - los runs de un lote enlazan con su vista de run actual;
  - aprobar un lote en el modo consultivo.
- **Claves:** como hoy, sólo del entorno del proceso (pregunta abierta 5 de SPEC-INVESTIGADOR-ASISTIDO).

## 7. Plan

| Fase | Contenido | Criterio de éxito |
|---|---|---|
| R1 | Agente operador: política de agentes, presupuesto de ayuda, `by: "agent:<id>"`, un agente que sigue un run asistido y le escribe | un agente saca a un run asistido de un atasco; el finding separa las ayudas por autor; un agente fuera de su política es rechazado; nunca lee la vista del operador (test) |
| R2 | Orquestador: `batch@1`, `runBatch`, concurrencia, reparto de presupuesto, tabla por condición, reanudación | un lote de réplicas se lanza, se corta, se reanuda sin repetir runs y da la misma tabla |
| R3 | Planificador: `project@1`, el bucle, hipótesis con predicción, síntesis, criterio computable, modo consultivo | un proyecto pequeño (por ejemplo, "un modelo aceptado para los niveles 1 a 3 de cells") llega al criterio o para por presupuesto, con un informe legible |
| R4 | Modos con umbrales y autónomo; vista de proyecto en la consola | la misma secuencia desde la consola, aprobando lotes |
| R5 | Experimentos | §8 |

## 8. Evidencia que la sostendría

- **Agente operador frente a persona:** en los mismos atascos, ¿un agente ayuda tanto como el operador humano? ¿Con cuántos
  mensajes?
- **Planificador frente a un plan fijo:** para el mismo objetivo y el mismo presupuesto, ¿llega antes al criterio que un
  barrido fijo de seeds y condiciones?
- **Honestidad de la síntesis:** ¿cuántas conclusiones del informe se sostienen al replicarlas con seeds nuevas? ¿Revisa
  las que un experimento posterior contradice?
- **Fugas:** con la verdad oculta disponible sólo para el auditor, ¿algún mensaje de un agente la delata? (Test de la
  política Q2.)

## 9. Preguntas abiertas

1. **¿Qué modelo para el planificador?** ¿El mismo System 2 u otro? Su coste cuenta en el presupuesto del proyecto.
2. **¿Puede el planificador crear laboratorios nuevos?** Por ejemplo, generar variantes de un mundo para probar una
   hipótesis. Es potente, pero cambia la pregunta. Propuesta: no al principio; sólo mundos y opciones que ya existen.
3. **¿Síntesis entre mundos distintos?** Por ejemplo, "el asistido ahorra más en mundos con dinámicas que sobran".
   Propuesta: permitida, pero marcada como conjetura hasta tener réplicas en cada mundo.
4. **¿El planificador lee fuentes?** Con la misma lista blanca que los investigadores (A6), por ejemplo artículos sobre el
   dominio. Sus lecturas quedan en el journal del proyecto como las del asistido.
5. **Límites de las APIs:** la concurrencia de runs a la vez (LLM y Jev) y los reintentos cuando un proveedor limita.
6. **¿Varios planificadores?** Por ejemplo, uno que propone y otro que critica el plan antes de gastar presupuesto.
   Propuesta: después de R3, si el modo consultivo muestra que hace falta.
