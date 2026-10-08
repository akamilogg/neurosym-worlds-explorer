# SPEC · Agentes operadores, orquestador y planificador de proyectos

Estado (30/09/2026): **R1–R4 y R3b implementados** (§10), probados con modelos sustitutos. Falta R5: los experimentos con
LLM real.

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

### 3.3 El senior: un modelo más capaz que revisa a un junior atascado (idea del autor, 02/10/2026)

**De dónde sale.** Los modelos pequeños tropiezan con indicios de la solución y no los conectan.
- Luna hizo un barrido de cinco `act` que mostraba qué direcciones se aceptaban, y no lo convirtió en regla.
- Mantuvo como «mera asociación» que las derrotas acababan en el borde derecho, que es la regla verdadera.
- El empujón externo ya sacó a un run de su mínimo local (particles3d L1 C).

Un agente con un modelo más capaz puede hacer de senior que revisa a un junior.

**Qué es.** Un papel del agente operador (`--role senior`), junto al coach de siempre.
- **Cuándo interviene.** Solo cuando el run muestra señales de atasco (`stuckSignals`):
  - `patience` pruebas seguidas en que el modelo no se sostiene en ningún lugar (3 por defecto);
  - peticiones repetidas en la última ronda;
  - insistir en investigar sin pasos.
  
  - **una ronda de solo mirar:** `looking` respuestas de investigación (3 por defecto) sin ningún experimento (`act`,
    `replay`, `table`, `measure`, `simulate`), solo `view`, `inspect` o lecturas. Es la señal de un junior que duda o
    investiga de más y no llega a formular una hipótesis que pruebe. La ronda 1, sin modelo todavía, no cuenta.

  - **regresiones:** al menos 2 episodios de pruebas anteriores que puntúan menos al repetirlos con los modelos nuevos
    (en las últimas `window` pruebas, 2 por defecto). Sus cambios deshacen lo que funcionaba.
  - **sin progreso:** su mejor prueba (la de mayor proporción de episodios a 1) no se ha igualado en `window` pruebas.
  
  Las dos últimas se añadieron el 02/10/2026, tras un run de Luna con 4, 5, 3 y 4 victorias de 8 y regresiones en las
  repeticiones, en el que el senior no volvió a intervenir.

  Son recuentos mecánicos de hechos del registro, no un diagnóstico: deciden cuándo merece la pena llamarlo, que es lo
  caro. El diagnóstico es suyo.
- **Pausa tras un mensaje.** Tras un mensaje, el senior espera a que el junior lo **reciba** y deja `cooldown` pruebas (2
  por defecto) contadas **desde la entrega**, no desde el envío. Un mensaje enviado durante una respuesta larga del junior
  le llega una ronda después. Contando desde el envío, el senior quedaba bloqueado justo cuando el junior acababa de
  leer el consejo.
- **Seguimiento de sus propias hipótesis (02/10/2026).** El junior recibe su mensaje y después hace un experimento (`act`,
  `replay`, `table`, `measure`). En ese momento se llama al senior **dentro de la misma ronda**, una vez por mensaje
  (`followUpDue`), sin esperar señales ni la pausa. Lee el resultado y decide:
  - si los datos del junior **confirman** la hipótesis sin contraejemplos, se lo dice citándolos, le pide que la adopte
    como regla de trabajo y que **proponga ya** un modelo construido sobre ella;
  - si la **refutan**, se lo dice para que la descarte;
  - si no es concluyente, espera.
  
  Con una regla confirmada puede decirle **cómo la usa su modelo** en la forma que pide el entorno (qué puntos valen lo
  mínimo o lo máximo según la regla), pero nunca escribe el código.
  
  Motivo: run de Luna `grid-s22-2026-10-02T11-32-33-166Z`. El senior apuntó la columna derecha y el bloqueo de `=`; Luna
  hizo los experimentos y obtuvo 6 de 6 derrotas en la columna derecha y una victoria inmediata al bloquear. Aun así lo
  dejó como «sample association» y siguió con heurísticas de distancia. Faltaba alguien que cerrase el ciclo.
  
  Cada seguimiento gasta una ayuda: para estos runs, `--help-budget 6`.
- **Un investigador con tarea propia (02/10/2026).** Su papel le da la misma tarea que al junior: entender el entorno. El
  registro del junior son sus datos.
  - No solo revisa ni pule la operativa del junior: investiga ese registro por su cuenta, busca correlaciones y tácticas
    que el junior no vio y formula **hipótesis nuevas**, rivales de las del junior, en vez de refinar su modelo.
  - Prioridad a lo que el entorno **es**: qué permite y qué rechaza, y cómo terminan los episodios. Un modelo construido
    sobre reglas confirmadas supera a una heurística afinada, así que ajustar el modelo del junior solo merece un mensaje
    cuando las reglas están claras.
  - Un seguimiento que solo propondría otro pequeño ajuste del modelo rara vez merece un mensaje.
  - Motivo: run `grid-s22-2026-10-02T12-00-16-111Z`. Tras un buen primer ciclo sobre una regla (las `&` no pasan a
    columnas mayores, confirmado con un `act` y adoptado), los seguimientos encadenaron cinco mensajes de ajuste
    táctico de la heurística. El presupuesto se gastó sin volver a las reglas, y el encierro de `=` ni se mencionó.
- **Coste (02/10/2026).** Con precios de proveedor (Sol 2 $/M de entrada y 10 $/M de salida; Luna 0,10 $ y 0,50 $),
  el senior costaba ~0,4–0,7 $ por run frente a ~0,1 $ del junior Luna. No era por trabajo, sino por contexto repetido:
  18 llamadas, cada una con el sistema (~6k tokens), el resumen del run (3–5k) y lo leído acumulado. Lo encarecían
  sobre todo los seguimientos, con 2–4 llamadas cada uno, porque tenía que abrir el experimento del junior.
  - El seguimiento lleva el experimento del junior tal como lo guarda su registro (`follow_up.its_record`: lo que pidió y
    lo que se le respondió). Por regla general se decide en una llamada.
  - El resumen del run en cada llamada es de las 3 últimas rondas (`digestRounds`); lo demás está para leerlo.
  - Cada decisión registra su coste en el journal del agente (`usage`: llamadas, tokens de entrada, cuántos cacheados,
    salida y `cost` del proveedor), y el registro lleva el total.
  - Proyección sobre el run `grid-s22-2026-10-02T12-39-45-095Z`: de 18 a 9 llamadas, y de ~0,41 $ a ~0,14 $.
  - Medido después (run de Qwen `grid-s22-2026-10-02T16-06-47-102Z`): 0,67 $ en 14 llamadas.
    - Los seguimientos de una llamada costaron 1–3 céntimos.
    - Lo caro fueron las decisiones con lectura: 3–4 llamadas de ~20k tokens.
    - Solo se cacheaba su sistema, porque lo leído crecía dentro de un único mensaje, y abría partidas enteras.
  - Por eso la pregunta del senior también va en varios mensajes, como la del junior:
    1. su contexto (señales, resumen, seguimiento, decisiones), sin cambios durante la decisión;
    2. un mensaje por cada paso de lectura (`investigation_step`);
    3. al final, `steps_left`.
  - Medido con la conversación que solo crece (run de Luna `grid-s22-2026-10-02T17-53-46-721Z`):
    - el senior pasó de un 23 % a un 58 % de entrada cacheada;
    - aun así costó 0,53 $, porque cada seguimiento le llevaba 2–4 llamadas: leía más del registro antes de contestar.
  - Desde entonces, **un seguimiento le permite una sola lectura**, porque el experimento ya lo tiene delante. Si pide
    leer más, no hay error: se le añade un recordatorio («tu papel no es hacer el trabajo del junior: decide ya; dale
    la hipótesis con la que seguir, o la tarea que debe continuar, o espera») y se le pregunta de nuevo, como mucho dos
    veces. La decisión registra `reminded`.
  - Los elementos del registro de más de `openLimit` caracteres (4000) se le abren recortados: el principio y el tamaño.
    Con `"whole": true` los lee enteros. La memoria del propio junior sigue abriéndolos siempre enteros.
- **Hipótesis, prueba y cómo incorporarla (03/10/2026).** Un junior a menudo enuncia una regla que su registro
  sostiene y no la lleva a su modelo, que sigue puntuando con otros rasgos. Lo ha hecho Luna con la columna 4 en varios
  runs. Por eso cada mensaje del senior lleva:
  - la hipótesis;
  - la evidencia;
  - un experimento;
  - **cómo usaría el modelo la hipótesis una vez confirmada**: qué puntos valen lo mínimo o lo máximo según la regla, qué
    tendría que medir una observación y en qué debería dejar de apoyarse.
  
  Si el registro ya confirma una regla que el modelo no usa, lo dice y muestra cómo usarla. Nunca escribe el código, y
  el junior lo trata como referencia que debe comprobar.
- **Después de la reflexión final no escribe.** Ya no hay más preguntas al junior, así que el mensaje nunca le llegaría y
  gastaría una ayuda del presupuesto. Pasó en el run de Luna `grid-s22-2026-10-02T10-57-10-816Z`. El agente sigue
  atento: en una continuación decide en la prueba siguiente.
- **También dentro de la ronda (02/10/2026).** Al principio solo se le llamaba al acabar una ronda.
  - En el run `grid-s22-2026-10-02T10-10-45-109Z`, Qwen pasó la ronda 3 mirando 12 tableros, insistió sin pasos hasta
    agotar los recordatorios y la ronda acabó sin propuesta. En la cuadrícula eso termina el run, así que el senior no
    llegó a actuar.
  - Ahora, cuando una señal es de la ronda en curso (solo mirar, o insistir sin pasos dos veces), se le llama en ese
    momento, una vez por ronda (`during_round`).
  - Su mensaje llega con la siguiente pregunta al junior, dentro de la misma ronda, antes de que se agoten los
    recordatorios.
  - Su papel le dice que entonces le ayude a comprometerse: señalar la hipótesis que mejor sostiene el registro y pedirle
    que proponga ya un modelo que la pruebe («un modelo que falla también enseña»).
- **Qué ve.** Exactamente lo que vio el junior (Q2), reconstruido desde su journal (`reader.ts`, `journalReader`):
  - creencias, notas y métodos;
  - sus modelos;
  - cada petición **con lo que el entorno le respondió**;
  - los veredictos de cada prueba;
  - sus episodios con su puntuación.
  
  Nunca la parte oculta, las medidas del operador ni cómo acabó un episodio más allá de su puntuación (el motivo, como
  «trap», es del mundo). Para ello la cuadrícula registra ahora también `results` en cada `investigation`, como ya
  hacían los mundos de leyes.
- **Cómo indaga.** Con las mismas herramientas que la memoria selectiva del junior (`list`, `open`, `find`), sobre el
  registro del junior, durante hasta `readSteps` respuestas (4).
- **Qué propone.** Una sola hipótesis, con la evidencia del registro del junior que la sugiere (citando elementos y
  puntos) y un experimento para comprobarla.
  - Nunca afirma como hecho lo que el registro no muestra.
  - Nunca da la solución entera: el junior debe probar la idea y construir el modelo.
- **Registro.** En el journal del agente (`agent@1`, `role: senior`), cada decisión guarda:
  - las señales por las que se le llamó;
  - lo que leyó;
  - la evidencia en que se apoya.
  
  El mensaje llega al junior como cualquier ayuda, atribuido a `agent:<id>`, dentro de la política del run
  (`--agents senior=message`) y de su presupuesto de ayuda (`--help-budget`).
- **Modelo.** `AGENT_LLM_URL` y `AGENT_LLM_MODEL` (por defecto el de los investigadores). La idea es un modelo más
  capaz que el del junior.
- **Su prompt: un investigador con otra capacidad, no otro método.** Se compone de tres partes:
  1. su papel;
  2. el **brief del junior palabra por palabra** (`juniorBrief`): el prompt común (persona, método, instrumentos,
     protocolo) y la interfaz del mundo, reconstruidos a partir del journal (mundo, instrumentos, regresión, foco). Se
     omite solo la forma de la propuesta, porque esa respuesta es del junior;
  3. sus instrucciones de revisor.
  
  Cualquier cambio del método común le llega igual que al junior. La comparación junior-senior mide la diferencia de
  modelo, no de instrucciones.

**Uso:**
- `lab agent <run> --role senior [--patience N]`, sobre un run asistido lanzado con `--agents senior=message`;
- en un lote: `"agent": {"id": "senior", "role": "senior"}`.

**Riesgo y cómo se mide.**
- Si el senior propone de más, el run mide al senior y no al junior.
- Por eso el presupuesto de ayuda y la atribución en el finding: se sabe qué creencias nacieron de un mensaje (`operator:<id>` en su evidencia).
- La pregunta del experimento es si el junior **aprende o solo obedece**: si la hipótesis del senior acaba como creencia con evidencia propia (sus `act`, sus pruebas) o solo citada.
- Diseño propuesto: Qwen como junior en grid seed 22, en tres condiciones (solo, con coach, con senior Luna o Sol).

### 3.3.1 El senior como investigador con memoria (implementado, 05/10/2026)

**De dónde sale.** En el run N2 de `navigation-goals` (`runs/batches/c302nav-n2-task`), el senior aportó las tres ideas
que acabaron en el modelo aceptado. Aun así, cada decisión empezaba de cero:
- **Sólo cacheaba el 29 % de su entrada** (el junior, el 62 %). En cada decisión pagaba otra vez el resumen de las 3
  últimas rondas, y la ventana avanzaba, así que ni ese resumen se reutilizaba.
- **No recordaba su propio razonamiento.** Lo único que veía de antes eran sus decisiones (`your_decisions`), no por qué
  las tomó ni lo que había leído.
- **Al reanudar el run perdía todo.** El senior nuevo repitió una hipótesis parecida a la última y gastó una ayuda.
- **No tenía dónde anotar.** Siendo un investigador con tarea propia (§3.3), no podía guardar sus hipótesis, sus
  métodos ni lo que había descartado.

Idea del autor: si un senior sigue a un junior, no tiene por qué olvidarlo todo. Es un investigador en toda regla,
aunque no actúe sobre el mundo, y puede tener su propio cuaderno, anotar insights y recuperar métodos.

**Qué cambia.**
- **Una conversación que sólo crece en todo el run**, no una por decisión. Funciona como la del junior dentro de una
  ronda:
  1. el sistema (igual que hoy);
  2. su contexto inicial: su cuaderno y el resumen del run hasta ese momento;
  3. en cada decisión se añade sólo lo nuevo: las rondas completadas desde la anterior (`new_rounds`), las señales o el
     seguimiento por los que se le llama, y después sus lecturas y su decisión.
  
  Nada de lo enviado cambia después, así que en cada decisión se reutiliza el prefijo de todas las anteriores.
- **Consolidar, como el junior.** Cuando lo crea conveniente, el senior responde `{"consolidate": {"summary": "...",
  "keep": [...]}}`. Su conversación se reinicia desde un contexto nuevo: su cuaderno tal como está, su resumen y los
  pasos que quiso conservar. Rompe la caché una vez.
  - Si la conversación pasa de un tamaño (`maxContextTokens`, unos 150k por defecto), se le pide que consolide antes de
    seguir, con un aviso como los de "sin lecturas".
  - El arnés nunca resume por él.
- **Su propio cuaderno**, el mismo `Notebook` del junior y en el mismo formato:
  - **creencias** con postura (`new`, `keep`, `revise`, `confirm`, `drop`) y evidencia del registro del junior;
  - **notas;**
  - **métodos**, cómo lee y cruza el registro, que recupera en cada consolidación.
  
  Lo escribe con los mismos campos que el junior (`beliefs`, `notes`, `methods`) en cualquiera de sus respuestas,
  también en las que sólo lee o espera.
- **Su memoria también cubre su cuaderno.** `list`, `open` y `find` leen hoy el registro del junior. Añaden los tipos
  `my_beliefs`, `my_notes` y `my_methods`, y sus decisiones anteriores con lo que leyó (`my_decisions`).
- **Sobrevive a una reanudación.** Su estado (cuaderno, decisiones y la conversación desde su última consolidación) vive
  en su registro (`agent@1`). Un run reanudado, sea por el lote o con `lab agent`, carga el del run del que deriva y
  sigue donde estaba.

**Qué no cambia.**
- Sólo lee el registro del junior; nunca actúa sobre el mundo ni ve la parte oculta (Q2).
- Su cuaderno **es suyo:** el junior nunca lo ve. Lo que le llega son sus mensajes, como hoy, con la misma política
  (`--agents`) y el mismo presupuesto (`--help-budget`).
- **Cuándo se le llama no cambia:** señales, pausa tras un mensaje, seguimiento y dentro de la ronda (§3.3). Una espera
  sigue sin gastar ayuda, y ahora además le deja escribir en su cuaderno.
- El brief del junior palabra por palabra y el percepto (§3.3) siguen en su sistema.

**Medidas (sólo operador).**
- **Coste:** la entrada cacheada por decisión y en el total del run. Se espera pasar del 29 % a más del 70 %.
- **Lo que entendió el senior frente al junior.** Con verdad, el calificador puntúa también el cuaderno del senior
  (`operator_rule_recovery` con `subject: senior`). Así se sabe si las ideas se quedaron en el senior o llegaron al junior.
- **Si el junior aprende o sólo obedece** (§3.3): ahora puede compararse cada creencia del senior con la del junior que
  nació de su mensaje.

**Coste estimado.** En el run N2, el senior hizo 24 llamadas con 0,73 M tokens de entrada (29 % cacheados) por 1,42 $.
- Con la conversación persistente, cada decisión paga sólo lo nuevo: una o dos rondas y sus lecturas, en vez de tres
  rondas más todo lo leído.
- La conversación crecerá, y las consolidaciones lo compensan.
- Estimación grosera: entre un 40 % y un 60 % menos de coste a igual número de decisiones. Se medirá.

**Plan.**
- **S1.** Estado persistente del senior en su registro: cuaderno, decisiones y conversación. Carga al reanudar.
- **S2.** La conversación que sólo crece entre decisiones (`new_rounds`), con `consolidate` y el aviso de tamaño.
- **S3.** Su cuaderno: campos `beliefs`, `notes` y `methods` en sus respuestas, y los tipos `my_*` en su memoria.
  Su papel (`SENIOR_ROLE`) explica el cuaderno y la consolidación, sin tocar el brief del junior.
- **S4.** El calificador sobre su cuaderno, la entrada cacheada en el informe del lote, y pruebas: estado que sobrevive
  a una reanudación, prefijo que no cambia entre decisiones, consolidación y cuaderno.
- Validación: repetir el run N2 con la misma seed y comparar coste, entrada cacheada, mensajes y resultado.

**Implementado (05/10/2026).** Las piezas:
- **Su estado** (`lib/src/orchestra/senior.ts`, `SeniorState`) vive en su registro (campo `senior`). Contiene:
  - su cuaderno;
  - su conversación desde la última consolidación;
  - la última ronda del junior que ya ha visto (`since`);
  - sus seguimientos y llamadas dentro de ronda.
- **La reanudación** no necesita nada del lote. El journal reanudado guarda `resumed_from` en su evento de inicio, y el
  agente lee de ahí el registro del run anterior:
  - toma su estado y sus decisiones (`earlier`);
  - cuenta sus órdenes;
  - no vuelve a decidir sobre rondas ya decididas.

  La consola dice «goes on from …».
- **La conversación** (`seniorDecides` en `agent-operator.ts`):
  - la abre con su cuaderno y las 3 últimas rondas;
  - en cada decisión añade `new_rounds` (sólo las rondas posteriores a `since`) y `call` (`n`, señales, `during_round`,
    `follow_up`, órdenes restantes, memoria, pasos);
  - después, sus lecturas (`investigation_step`, con ids `d<llamada>.<paso>`) y `your_decision`.

  Lo que escribe en el cuaderno se le devuelve como `you_wrote`.
- **Consolidación:** `{"consolidate": {...}}`, como mucho dos veces por llamada. Pasado `maxContextTokens` (150k
  estimados), se le pide; si a la segunda no lo hace, la conversación se reinicia desde su cuaderno.
- **Su memoria** (`seniorMemory`): los tipos `my_beliefs`, `my_notes`, `my_methods` y `my_decisions` junto a los del
  junior. `open` mezcla ids de ambos en el orden pedido, y `find` sin tipo devuelve también los suyos (`yours`).
- **Su papel** (`SENIOR_ROLE`) explica la conversación, el cuaderno y la consolidación. El brief del junior no cambia.
- **Medidas:**
  - `lab grade <run> --senior [id]` califica su cuaderno (creencias, notas, métodos y los mensajes que envió) contra la
    verdad, con el calificador del run. El resultado va a su registro (`gradings`, `subject: senior`), nunca al journal
    del run.
  - El informe del lote dice, por run, lo que costó su agente: decisiones, llamadas, tokens de entrada, porcentaje
    cacheado y coste, sumando los runs de los que se reanudó (`agentUsage`).
- **Pruebas** (`lib/test/orchestra-senior-memory.test.ts`):
  - una decisión posterior repite todo lo anterior y añade sólo lo nuevo;
  - el cuaderno se escribe y se relee;
  - la consolidación y el aviso de tamaño;
  - el estado sobrevive a una reanudación;
  - la calificación del senior y el informe del lote.

### 3.3.2 Investigación pendiente: junior y senior del mismo modelo, pensamiento rápido y lento (idea del autor, 06/10/2026)

**La idea.** El senior y el junior son el **mismo modelo** con distinto esfuerzo de razonamiento. Por ejemplo, dos Luna:
- **el junior, con esfuerzo bajo:** el pensamiento operativo y rápido, que actúa sobre el mundo, experimenta y propone
  modelos;
- **el senior, con esfuerzo alto:** el pensamiento estratégico y lento, que no actúa, relee el registro, mantiene su
  cuaderno y propone hipótesis cuando el junior se atasca.

La intuición del autor: esa combinación supera a un solo junior con esfuerzo alto. La razón sería que separa los dos
modos de pensar en dos papeles con memoria propia, en vez de pedirle a un solo agente que haga las dos cosas a la vez.

**De dónde sale.** El arnés ha encontrado soluciones en dominios muy distintos (juegos, leyes físicas, biología). En
`navigation-goals` (`c302nav`), el senior (§3.3.1) aportó las tres ideas que acabaron en el modelo aceptado, y el
junior hizo el trabajo voluminoso (§3.3.1, run N2). Falta saber cuánto de esa ventaja viene de un modelo más capaz y
cuánto de **la división en dos papeles**. Con el mismo modelo en ambos, la diferencia sólo puede venir de la división.

**Diseño propuesto.** Condiciones con el mismo mundo, las mismas seeds, la misma tarea y las mismas herramientas:

| | junior | senior |
|---|---|---|
| A | Luna, esfuerzo bajo | — |
| B | Luna, esfuerzo alto | — |
| C | Luna, esfuerzo bajo | Luna, esfuerzo alto (con memoria, §3.3.1) |
| D | Luna, esfuerzo alto | Luna, esfuerzo alto |
| E (referencia) | Luna, esfuerzo bajo | Sol |

- **La hipótesis principal es C > B a igual coste.** C gasta más que A, así que la comparación justa es frente a B con el
  mismo presupuesto de tokens o de dinero. Si C sólo gana porque gasta más, no hay efecto de la división.
- **La comparación C frente a E** dice cuánto aporta un modelo más capaz por encima de la división en papeles.
- **Mundos:**
  - `c302nav` en la condición N2, que es difícil y donde ya sabemos que el senior aporta;
  - el grid, seed 22, con historial de senior;
  - `particles3d`.

  Varias seeds por condición.

**Medidas:**
- **El resultado:** si se acepta, en qué ronda y la recuperación de insights.
- **El método:** la auditoría.
- **Lo que entendió cada uno:** el senior con `lab grade --senior` y el junior con su propia calificación.
- **El coste y la caché**, de cada uno.
- **Si el junior aprende o sólo obedece** (§3.3).

**Lo que falta para poder hacerlo:**
- **Fijar el esfuerzo de razonamiento del senior.** Hoy el junior puede fijarlo con `LLM_EXTRA_BODY` (el parámetro del
  proveedor, por ejemplo `{"reasoning": {"effort": "low"}}`). El senior no tiene su equivalente: hay que añadir
  `AGENT_LLM_EXTRA_BODY` y, en un lote, la opción de darlo por agente.
- **Registrar en el registro del senior su modelo y sus parámetros,** que hoy no se guardan, para que cada condición
  quede declarada.
- **Presupuestos comparables:** el lote ya fija tokens por run; habría que poder fijarlos sumando los del agente.

### 3.3.3 Las órdenes del senior: equilibrar el escepticismo del junior (implementado, 06/10/2026)

**Lo observado.** Run `runs/batches/c302nav-n2-task12-2` (condición N2, senior con memoria):
- **El senior, desde la ronda 5,** le pidió cuatro veces que construyera el modelo sobre un estado persistente **en
  código**. Las dos últimas, con la medida exacta del decaimiento confirmada con un control emparejado (≈ 0,9785 por
  paso de 5 ms, en AWCL y en AWCR).
- **El junior** hizo los experimentos que le pedía y anotó los hallazgos, pero en 12 rondas no escribió ni una
  observación numérica: siguió con termómetros de Jev, de 2 a 38 reglas.

**El criterio del autor.** El escepticismo es bueno, pero a estas alturas el junior está en total insubordinación: el
senior le ha indicado explícitamente que plantee observaciones en código y no lo ha hecho. Hay que equilibrarlo.

**De dónde puede venir.** Su prompt le pide leer los mensajes «como sugerencias de un colega, que pueden ser
erróneas», y que no son evidencia. Es correcto para no obedecer a ciegas. Pero no le pide **responder** a una
sugerencia: puede no seguirla nunca sin decir por qué, y nada en el registro lo hace visible.

**Opciones, sin decidir.** Ninguna da al junior análisis hechos ni le dice cómo es el mundo:
1. **Rendir cuentas, no obedecer.** Igual que con sus creencias, el junior toma postura ante cada mensaje: lo adopta y
   lo prueba, o lo rechaza con evidencia de su registro. Si lo deja sin postura, se le señala, como ya se hace con las
   creencias sin postura. Su respuesta queda en el journal.
2. **El modelo como experimento.** Cuando un mensaje propone un cambio de **forma** del modelo apoyado en datos que el
   propio junior confirmó, se espera que lo pruebe al menos una vez como propuesta («un modelo que falla también
   enseña», ya en su método), y luego decida con el veredicto.
3. **Escalado del senior.** Si su indicación lleva ignorada varias decisiones, el senior lo ve en su memoria y puede
   plantearla como experimento de una ronda, no como sugerencia general.
4. **Medirlo:**
   - qué fracción de los cambios que propone el senior aparece en los modelos siguientes;
   - cuánto tarda en aparecer;
   - si llega con evidencia propia del junior (si aprende o sólo obedece, §3.3).

La 1 y la 4 cambian poco y hacen el comportamiento visible sin forzarlo. La 2 toca el prompt común del investigador
asistido: es un cambio deliberado del método que hay que decidir. El investigador puro queda congelado.

**Decisión del autor (06/10/2026).** Los mensajes del senior son siempre **órdenes** del senior al junior. El junior
puede informar al senior, o anotar en su cuaderno, cualquier discrepancia con la hipótesis o el método propuestos,
pero las cumple.

**Implementado:**
- **El senior envía órdenes.** Sus mensajes llevan `directive: true` (`RunOrder`), y el runner conserva la marca al
  entregarlos.
- **El prompt del junior.** Su cliente (`operatorClient`, el mismo para los mundos de leyes y el grid) añade al prompt
  del investigador asistido, desde que le llega la primera orden, la sección `DIRECTIVES_SECTION`. Le dice que:
  - las órdenes se cumplen: hacer el experimento, llevar al siguiente modelo lo que se le indica y dejar lo que se le
    dice que deje;
  - si discrepa, la cumple igualmente y dice por qué, en su cuaderno y al senior con `"to_senior": "..."`;
  - informa de cada orden cumplida con `"directives": [{"id", "done"}]`, en cualquier respuesta.
  
  Sin órdenes, su prompt y sus preguntas no cambian.
- **Lo que informa, al registro.** Lo que el junior informa se registra (`directive_report`, `junior_report`), y una
  orden informada se cierra.
- **La propuesta se devuelve una vez.** En los mundos de leyes, una propuesta hecha con una orden abierta se le devuelve
  **una vez** (`proposal_refused` con `returned: true`), mediante el gancho opcional `vet` de `LawSession`. El
  investigador puro no lo tiene.
- **El senior lee los informes.** Cada llamada le trae los informes nuevos (`junior_reports`: órdenes cumplidas y
  discrepancias, `reports_seen` en su estado). Su papel dice que sus mensajes son órdenes: que las escriba para que se
  puedan cumplir y que cambie las suyas cuando la evidencia del junior sea mejor.
- **Pruebas:** `lib/test/orchestra-directives.test.ts`.

**Pendiente:**
- **Ajustes tras el run `c302nav-n2-task12-4`** (06/10/2026). Aceptado en la ronda 14, con 8 órdenes, 12 informes y
  7 discrepancias. Las 3 propuestas devueltas lo fueron porque la orden llegó sin pasos ni `act` en la ronda.
  - **La propuesta sólo se devuelve por una orden recibida en una ronda anterior.** Una que llegó en la ronda en curso
    queda abierta para la siguiente: el cliente anota la ronda de entrega de cada orden.
  - **`c302nav` devuelve cada `act` en las palabras de la interfaz** (`act.asWritten`), también en su respuesta
    (aceptado o rechazado). El investigador ya no ve los nombres internos del servicio (`changes`,
    `remove_connections`), que copiaba después.
  - **El tamaño de la conversación del senior** es el mayor entre la estimación y el recuento del proveedor
    (`prompt_tokens`). En ese run la estimación se quedaba corta, y el senior llegó a unos 300k tokens por llamada sin
    que se le pidiera consolidar.
- **El grid** recibe la sección y registra los informes, pero aún no devuelve la propuesta con una orden abierta: su
  bucle es propio.
- **Medir la adopción** (opción 4): qué órdenes acaban en el modelo y en cuánto tiempo.

### 3.3.3b El senior revisa primero el modelo y el método del junior (07/10/2026)

**El problema** (run `c302closed-n2-3`). Durante 10 rondas, el junior delegó toda la predicción en reglas de Jev: el
código sólo resumía la entrada y las reglas pedían «estima el comando a partir de la historia». El umbral, la
persistencia y el signo fijo del giro, que sus experimentos habían establecido, nunca entraron en el código, y ningún
check se sostuvo. El senior no lo corrigió por dos razones:
- **su resumen de cada ronda** sólo mostraba los primeros 500 caracteres de la salida del modelo, sin las observaciones
  ni las reglas. En 9 decisiones abrió el modelo completo 4 veces;
- **su papel** no le pedía revisar el modelo antes que nada.

**Cambios:**
- **`runDigest` (`modelDigest`):** el resumen de cada ronda muestra el modelo entero, recortado por partes: qué calcula
  cada observación (su código), qué pregunta cada regla a Jev (tipo e instrucciones) y la salida. Incluye también los
  métodos que el junior anota.
- **`SENIOR_ROLE`, «REVIEW ITS WORK FIRST»:** en cada llamada, antes de buscar nada nuevo, el senior revisa:
  - los informes de sus órdenes;
  - el modelo y el método del junior;
  - si el modelo incorpora lo que establecieron sus propios experimentos, en una forma que pueda calcularlo.

  Una cantidad o una dinámica establecida pertenece al código; si se delega en Jev o se pierde, ordena el cambio primero.
  Es método de revisión, sin pistas del entorno.
- **Los instrumentos propios del junior** (`juniorInstruments`): el prompt del senior incluye ahora las secciones de
  fuentes y de memoria tal como las recibe el junior, con sus orígenes.
  - **Por qué:** en el mismo run, el senior abrió un informe del instrumento (`ir-senior-1`) porque una petición `list`
    del junior le devolvía rutas de archivos. No sabía que eran las fuentes que el junior tiene permitidas.
- **El run del que salió todo esto** terminó sin aceptar, por presupuesto. El dato más revelador: en las rondas 14 y 15,
  y sólo en ellas, el junior propuso modelos sólo de código, y en la 15 obtuvo el mejor R² del run, 0,67 en la
  reorientación. En la 16 volvió a las reglas de Jev y cayó a 0,05.

### 3.3.4 La primera hipótesis la da el senior (idea del autor, implementado, 07/10/2026)

**El problema.** El junior empezaba con una hipótesis propia, y casi siempre el senior tenía que reencarrilarlo después
de varias rondas, gastadas en vías poco coherentes desde el principio. De los errores se aprende, pero mejor no
equivocarse en vano. A partir de ahora, junto con la tarea, el junior recibe del senior una primera hipótesis que
desarrollar.

**Cómo funciona:**
- **El run espera.** Con `--opening <agente>`, después de los primeros episodios el run registra `awaiting_opening` y
  espera una orden de ese agente antes de la primera pregunta al junior. El límite es `--opening-minutes`, 15 por
  defecto.
  - Si llega la orden, se registra `opening_received` y va con la primera pregunta como directiva (§3.3.3).
  - Si no llega, se registra `opening_missing` y el junior empieza solo.
  - Un run reanudado no espera: su historia ya la tiene.
- **El senior abre.** Cuando ve `awaiting_opening` con su id, se le llama aunque no haya señales de atasco, con la
  llamada marcada como `opening`.
  - **Qué pide su papel: un enfoque de investigación** (endurecido el 07/10/2026, a petición del autor, tras el primer
    run en lazo cerrado):
    - el senior había abierto con la relación obvia entre entradas y salidas («la suma mueve la reorientación, la
      diferencia el giro»), casi la línea base, que no es una hipótesis sobre el mecanismo;
    - ahora se le piden dos o más hipótesis rivales sobre el mecanismo, qué sugiere cada una y de cuál partir;
    - el método que las distinguiría con los instrumentos del junior: experimentos controlados, qué variar y qué
      mantener fijo, intervenciones, qué medir;
    - qué resultado refutaría cada una;
    - y cómo debe ser el primer modelo para probar la hipótesis de partida;
    - **la forma técnica del modelo, como parte del método** (añadido el mismo día, a petición del autor). Debe decir
      qué cantidades calculan las observaciones en código (a partir de qué del percepto y con qué tipo de cálculo), si
      usa reglas de Jev y, si las usa, para qué juicios que el código no puede hacer y por qué, y cómo las combina la
      salida.
      - **El criterio que se le da:** una cantidad o una dinámica que hay que estimar (un nivel, un retardo, una forma
        temporal, un umbral) se calcula en código, donde se puede medir, ajustar y corregir; una regla que pide a Jev
        estimar la respuesta a partir de un resumen oculta justo lo que la investigación debería fijar.
      - **Por qué:** en el run `c302closed-n2-3` la apertura dio buen método experimental y ninguna pauta técnica, y el
        junior delegó la predicción en Jev durante 13 de sus 16 rondas.

    Puede refutarse después: un plan refutado también enseña. Es guía de método del propio senior, sin pistas del
    entorno.
  - Si decide esperar, se le recuerda que sin su hipótesis el junior no tiene de dónde partir, hasta dos veces.
  - La decisión queda marcada con `opening: true`.
- **En los lotes** es lo predeterminado: un run nuevo con senior lleva `--opening <id>`; `"opening": false` en el
  agente lo desactiva.
- **Cuenta como ayuda:** es una orden de mensaje, así que gasta una del `--help-budget`.
- **Pruebas:** `lib/test/orchestra-directives.test.ts`. La primera pregunta del junior ya lleva la directiva; sin
  senior, el run espera lo indicado y sigue.

- **En el grid también:** su bucle llama al servicio común `awaitOpening` después de sus primeras partidas (prueba en
  `lib/test/memory.test.ts`).

### 3.3.5 Órdenes para lo sustancial: estado de los experimentos, prueba al validar y cobertura (08/10/2026)

**El problema** (run `c302closed-n2-4`, señales, y su auditoría externa):
- el senior gastó sus 16 órdenes en la ronda 13, y 4 fueron recordatorios de «tus experimentos se aceptaron, pero no
  los has leído». Cuando el modelo se sostuvo en todos los laboratorios (ronda 15), ya no le quedaban órdenes;
- ordenó validar, pero no probar el modelo fuera del terreno en que se ajustó (SPEC-PRUEBAS-PROPIAS §13);
- nadie contrastó el modelo con las preguntas de la tarea: la de *qué se arrastra y con qué escala de tiempo* quedó sin
  investigar, y el instrumento lo permitía.

**Cambios:**
- **El estado de cada experimento ordenado**, en el resumen del senior (`runDigest`) y en el cuaderno del junior. Se
  calcula del diario, sin juicio del entorno:
  - *pendiente*: ordenado y aún sin episodio;
  - *hecho*: hay episodio (o resultado de la prueba registrada);
  - *leído*: el junior lo abrió (`view`, `inspect`) o lo usó en `measure` o `table`;
  - *usado*: el junior lo cita como evidencia en una postura de creencia, una nota o su informe al senior (`to_senior`).

  Es contabilidad de lo que hizo el junior, no un análisis. Con ella, «aún no lo has leído» lo ve el junior sin que el
  senior gaste una orden. El papel del senior le dice que guarde sus órdenes para discrepancias de fondo y no para
  recordatorios que el estado ya muestra.
- **La orden de validar lleva una prueba.** Cuando el modelo se sostiene en todos los laboratorios, el senior ordena
  validarlo (§3.3.3b) y, con la misma orden, una prueba (`"test"`) en condiciones que ni la validación ni los episodios
  de serie exploran, donde las partes ajustadas del modelo se juegan algo, frente a un rival que explique igual lo
  visto. Es pauta de método, sin experimentos del entorno: qué prueba diseñar lo decide él.
- **El senior revisa la cobertura de la tarea** (SPEC-INVESTIGADOR-ASISTIDO §14). Antes de ordenar validar y al
  acercarse el final, contrasta lo que el junior dice haber respondido con su evidencia. Si una pregunta sigue abierta
  y el instrumento permite investigarla, ordena investigarla (o una prueba propia) antes de dar el trabajo por
  terminado. Si no lo permite, se asegura de que quede en un informe del instrumento (SPEC-CALIBRACION-INSTRUMENTOS §4).
- **Los documentos propios del junior** (SPEC-INVESTIGADOR-ASISTIDO §14.1) aparecen en su resumen: índice y cambios de la
  ronda. Puede abrirlos.
- **Modelos idénticos:** el resumen dice cuándo el junior vuelve a proponer un modelo ya visto, con su historial de
  veredictos por laboratorio (SPEC-CALIBRACION-INSTRUMENTOS §11.1).
- **Pruebas:** el estado de un experimento recorre los cuatro pasos con un diario sintético; el resumen del senior
  muestra el estado, los documentos y el aviso de modelo repetido.

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

### 5.5 Mínimos locales: informar y bifurcar (idea del autor, 30/09/2026)

Lo visto en el mundo 3D (SPEC-MUNDO-3D §10.6–10.8) es un patrón:
- el investigador se pone a optimizar su propia idea en un mínimo local;
- escribe hipótesis alternativas (en su teoría, en sus reflexiones) y no las explora;
- sigue puliendo la suya.

Un empujón del operador lo sacó en una ronda. El planificador puede hacer algo más: **explorar la alternativa en
paralelo, sin quitarle al investigador su línea**.

- **Informar al planificador.** El investigador le hace llegar qué está haciendo y qué otras hipótesis ve posibles. La
  fuente natural es su cuaderno: su nota de teoría con las rivales, su siguiente experimento y los planes que no ejecutó.
  El planificador lo lee de la vista del investigador (Q2).
  - Opcionalmente, el asistido podría declarar sus alternativas en un campo propio de cada respuesta.
  - El puro no sabe que existe un planificador: sólo se lee su journal, y leer no le cambia nada.
- **Detectar el atasco.** Son medidas del operador, sin analizar nada por el investigador:
  - varias rondas de variantes del mismo tipo de modelo sin mejora en la comprobación;
  - un siguiente experimento anotado y no ejecutado en las rondas siguientes;
  - hipótesis rivales escritas y nunca contrastadas.
- **Bifurcar.** El planificador lanza otro investigador **dirigido** a la hipótesis alternativa. Hay dos formas:
  - **una rama** de la misma historia: una continuación del journal original traspasada al asistido
    (SPEC-INVESTIGADOR-ASISTIDO §3.2), con un `task` o un mensaje que fija la alternativa. El journal original no cambia,
    así que se pueden derivar varias ramas de la misma historia, cada una con su hipótesis;
  - **un run nuevo** asistido con `--task` sobre la alternativa, sin la historia (y sin sus sesgos).

  El investigador original sigue con su línea. Si es el puro, sigue siendo puro: la rama es otro run.
- **Coordinar.** El planificador sigue las ramas a la vez:
  - las compara por sus findings, en coste y en si se sostienen;
  - puede pasar a una rama lo que otra ha establecido, como mensaje de colega y con procedencia;
  - cierra las ramas que no avanzan.

  Una rama es una apuesta: su resultado es una referencia para las demás, no una verdad.
- **El humano aprueba.** Abrir una rama gasta presupuesto. Según el grado de autonomía (§5.4):
  - consultivo: el planificador propone la rama (qué hipótesis, desde qué punto, con qué presupuesto) y el operador la
    aprueba;
  - con umbrales: la abre sola por debajo de un coste y pide aprobación por encima;
  - en ambos casos el operador puede parar ramas o cambiar presupuestos.

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
| R3b | Mínimos locales (§5.5): detección del atasco, informe de alternativas, ramas desde una historia (continuación traspasada) o runs nuevos con `task`, coordinación y aprobación humana | en un run atascado como el del nivel 1 C, el planificador propone una rama sobre la hipótesis que el investigador dejó sin explorar; aprobada, la rama la explora mientras el original sigue su línea, y el informe compara las dos |
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

## 10. Lo implementado (30/09/2026)

Todo está en `lib/src/orchestra/` (exportado como `neurosym/orchestra`) y sólo usa la API de control, `runLaboratory` y los
findings (Q1).

### 10.1 R1 · El agente operador (`agent-operator.ts`, `view.ts`)

- **Lo que ve un agente** (`researcherEvents`, `runDigest`): una lista blanca, campo a campo, de lo que el investigador
  vivió:
  - sus propuestas, investigaciones, creencias, notas, lecciones, planes y reflexiones;
  - lo que el mundo le dijo: si su modelo se sostuvo en cada lugar y si fue aceptado.

  Nunca `hidden_from_the_learner`, las medidas del operador (ablaciones, líneas base, trazas, la calificación) ni la
  descripción del mundo. Un test comprueba que la verdad no aparece.
- **El agente** (`runAgentOperator`): tras cada ronda que el run completa, decide `wait`, `message` o `stop`, con su
  motivo.
  - Su prompt le pide el empujón mínimo: primero devolverle al investigador sus propias ideas sin probar, y sólo después
    una pregunta que distinga sus rivales. Nunca hechos del entorno.
  - Sus órdenes van firmadas como `agent:<id>`.
  - Sus decisiones quedan en `<run>.agent-<id>.json` (`agent@1`).
- **La política del run:** `--agents <id>=<órdenes>;...` y `--help-budget N` son opciones de control; una reanudación las
  toma de nuevo.
  - Sin `--agents`, ningún agente puede ordenar el run; una persona, siempre.
  - Lo que se sale de la política se rechaza y queda registrado.
  - El presupuesto de ayuda cuenta la de todos, personas y agentes.
- **En el finding:** cada mensaje lleva su autor (`person` o `agent`), y el finding recoge el presupuesto de ayuda.

### 10.2 R2 · El orquestador (`batch.ts`)

- **El lote** `batch@1` declara sus runs: laboratorio, argumentos, investigador y condición. Opcionalmente, un agente que
  lo sigue, o una rama (`fork`).
- **La ejecución** respeta la concurrencia y reparte el presupuesto en tokens por run.
- **La tabla** va por condición y sale **sólo** de los findings de los investigadores:
  - aceptación y ronda (mediana y cuartiles);
  - coste hasta aceptar y coste total;
  - ayuda recibida.

  La **auditoría** (la calificación contra la verdad) va aparte y marcada.
- **Reanudable:** un run que terminó no se repite; uno cortado (o cancelado por el propio lote) se reanuda como run
  derivado. Un test comprueba que el lote cortado y reanudado da la misma tabla.
- **Salida:** `runs/batches/<id>/batch.json` y `batch.txt`.

### 10.3 R3 y R3b · El planificador (`project.ts`)

- **El proyecto** `project@1` guarda:
  - la pregunta y el criterio (código sobre los resúmenes de los runs);
  - la autonomía y el presupuesto;
  - por iteración: hipótesis con su predicción, plan, aprobación, lote, síntesis y resultado del criterio;
  - las conclusiones, con su respaldo y su historia, marcadas «replicada» o «se apoya en N runs»;
  - las preguntas abiertas y los eventos.
- **El criterio** lo da el operador o lo propone el planificador. En el segundo caso el operador lo aprueba antes de
  cualquier run. Se evalúa en un sandbox; lo decide el código, no el planificador (Q3).
- **Lo que ve el planificador** (Q2): los runs como sus investigadores los vivieron, y los laboratorios sólo por nombre,
  opciones y valores por defecto. Nada de lo que son: su texto de ayuda revela estructura y se colaría en los mensajes.
- **Un plan que no se puede ejecutar** (laboratorio inexistente, ids repetidos, presupuesto por encima de lo que queda,
  una rama de un run no ramificable) se rechaza con el motivo y se le pide otro.
- **Mínimos locales (R3b):** por cada run que no llegó, el estado muestra las señales del operador:
  - rondas, y rondas en las que el modelo no se sostuvo en ningún lugar;
  - modelos distintos;
  - las ideas que su investigador escribió y no probó;
  - si es ramificable.

  Una rama (`fork`) es una continuación del journal traspasada al asistido, con un primer mensaje de `agent:planner`
  (las ramas se autorizan solas en `--agents`). El run original queda intacto.
- **Presupuesto:** los tokens de los runs y los del propio planificador cuentan juntos (Q8).
- **Reanudable:** las llamadas del planificador pasan por su log de grabación (`planner.replay.<n>.jsonl`), las
  decisiones del operador ya dadas se aplican en el mismo orden y los lotes no repiten runs.

### 10.4 R4 · Autonomía, CLI y consola

- **Autonomía:**
  - consultiva: se aprueba cada plan;
  - con umbral: sin aprobación por debajo de `threshold` tokens;
  - autónoma.

  Rechazar exige una nota, que el planificador lee en su siguiente plan.
- **CLI:**
  - `lab agent <run> [--id coach]`;
  - `lab batch <batch.json>`;
  - `lab project start <goal.json> | list | status <id> | approve <id> [nota] | reject <id> <nota> | stop <id> | resume <id>`.

  El proyecto corre en un proceso propio (`scripts/run-project.ts`) con latido.
- **Consola:** una sección de proyectos con:
  - el estado y la autonomía;
  - el criterio y el presupuesto;
  - el plan que espera aprobación, con aprobar, rechazar con nota, parar y reanudar;
  - las iteraciones, con sus hipótesis y su tabla;
  - el informe.

  Los runs de un lote se abren en su vista de run.
- **Claves:** sólo del entorno (`LLM_*`, `PLANNER_LLM_*`, `AGENT_LLM_*`, `JEV_*`). La plantilla `lib/lab.example.ps1` las
  pone y lanza la CLI.
- **Ejemplos:** `lib/examples/batch.example.json` y `lib/examples/project.example.json`.

### 10.5 Pruebas

`test/orchestra-agent.test.ts`, `test/orchestra-batch.test.ts` y `test/orchestra-project.test.ts`, con modelos
sustitutos (System 2, agente y planificador) sobre `cells` y sobre `particles3d` con un Blender sustituto. Cubren:

- lo que ve un agente;
- la política y el presupuesto de ayuda;
- un agente que desatasca un run;
- un lote comparado, cortado y reanudado;
- un proyecto consultivo con rechazo y nota;
- el modo con umbral, parado y reanudado;
- una rama de un run atascado;
- la consola y la CLI de proyectos.

Los journals puros no cambian (0 diferencias con el LLM falso).

