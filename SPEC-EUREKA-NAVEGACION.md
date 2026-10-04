# SPEC · Un problema de EurekaBench como mundo de nuestro arnés: `navigation-goals` (c302)

Estado (04/10/2026): **propuesta, sin implementar.** Revisada el mismo día: el problema se porta como un mundo que
implementa nuestra interfaz de laboratorio; el arnés no se adapta a su evaluación.

Contexto: [EurekaBench](https://github.com/EurekaBench/EurekaBench) (Geng et al., 2026) evalúa agentes de código que
descubren mecanismos con simuladores científicos. De sus 24 problemas, los de la clase "simulador como mundo" son los que
se pueden traer como mundos (ver el análisis de la conversación del 04/10). `navigation-goals` es el primero: su entrada
es sólo un estímulo, su verdad es el comportamiento de un simulador que corre en CPU, y tiene una evaluación automática
clara.

## 1. Para qué

- **Un mundo de "ciencia real" más.** El investigador trabaja aquí exactamente como en la cuadrícula o en el mundo 3D:
  mismo prompt común, mismos instrumentos, mismo protocolo, mismo modelo (observaciones en código, reglas que juzga Jev,
  `output`).
- **Validación externa.** El problema y sus criterios los diseñaron otros. Se puede leer el modelo del investigador con
  sus mismas medidas, como una lectura más del operador.
- **Una pregunta que nuestros mundos generados no permiten.** El mismo mundo con y sin el encuadre de la literatura
  (§5): cuánto viene de descubrir con los instrumentos y cuánto de lo que el modelo ya sabe de *C. elegans*.
- **El método, que ellos no miden.** Nuestra auditoría del método se aplica tal cual.

## 2. El problema

**Lo que se descubre es el comportamiento de c302**, el modelo del sistema nervioso de *C. elegans* de OpenWorm, no la
biología. Hay dos señales de acción, que se leen del calcio (`caConc`) con un filtro causal de 200 ms:

- **reorientación** = media de `AVAL` y `AVAR` menos media de `AVBL` y `AVBR`;
- **giro (steering)** = `RIAL` menos `RIAR`.

**La entrada** es sólo la corriente inyectada en las dos neuronas olfativas, `AWCL` y `AWCR`: entre 2,5 y 6 pA durante
9 s. La simulación usa el nivel `C1`, `dt` de 0,05 ms y muestreo cada 5 ms, sobre un panel de 28 células:

- sensoriales;
- primera capa (AIA, AIB, AIY, AIZ);
- integrador (RIA);
- núcleo (RIM, AVE, RIB);
- mando (AVA, AVB);
- motoras de la cabeza.

**Lo que hay que explicar:**

- qué decide, en cada momento y sobre qué historia del estímulo, cuál de las dos acciones produce el mismo estímulo y con
  qué fuerza;
- qué arrastra esa decisión de una muestra a la siguiente;
- qué termina una racha de reorientaciones.

Su rúbrica de *insights* apunta a un estado que persiste con dos valores discretos, cuyos cambios dependen de la
dirección en que cambia el estímulo.

**Dos familias de estímulo:**

- **la vista:** trenes irregulares de pulsos cuadrados, con anchura, separación, total y reparto entre lados sorteados
  cada uno por su cuenta;
- **la no vista:** trenes periódicos de anchura y periodo fijos, con el total y el reparto girando suavemente a lo largo
  del run.

**Su evaluación**, como referencia, se hace sobre 100 configuraciones precalculadas, un tercio de ellas de la familia no
vista:

- R² conjunto y por señal, R² por configuración, y R² en la familia no vista;
- la persistencia de la reorientación predicha (semivida de su autocorrelación);
- la parte lenta de la reorientación;
- todo ello medido frente a dos líneas base: el estímulo promediado y el estímulo suavizado a 3 s.

Su mecanismo de referencia da un R² conjunto de 0,59. Hay además 5 restricciones científicas y 18 *insights* que juzga un
LLM.

## 3. Principios

- **E1. El problema se trae como mundo; el arnés no cambia por él.**
  - El laboratorio implementa la interfaz de siempre: mundo, sentidos, episodios, acciones, objetivo, familia, lugares
    ciegos y la verdad del operador.
  - Nada de su contrato de agente nos ata: ni que el modelo sea Python, ni el límite de constantes, ni la prohibición de
    componentes aprendidos, ni la de usar un juez.
  - Si algo del arnés hace falta, se añade de forma genérica y sirve a todos los mundos.
- **E2. Implementación propia; su código y sus datos no entran en el repositorio.**
  - Su repositorio no declara licencia.
  - Escribimos nuestro propio envoltorio de c302, que es de OpenWorm y se instala aparte, y nuestros propios generadores
    de estímulo, a partir de lo que describen.
  - Su conjunto de prueba (`heldout.npz`) se lee sólo de una copia local que el operador descarga (`--eureka <ruta>`), y
    sólo para la lectura del operador (§6). Nunca se copia ni llega al investigador.
- **E3. Decide el mundo, como siempre.** El investigador recibe lo que el simulador grabó y lo que su modelo respondió,
  como hechos, nunca una métrica. Si el modelo se sostiene lo deciden nuestros checks, validaciones y confirmaciones
  ciegas.
- **E4. Su evaluación es una lectura del operador, no el criterio.** Aplicamos sus medidas al modelo del investigador
  sobre su conjunto de prueba, reimplementadas a partir de su descripción, y se informan al lado de nuestro resultado.
  Donde no son comparables, se dice (§6).
- **E5. Condiciones declaradas.** El encuadre de la literatura es ayuda y queda en el journal y en el finding. El
  investigador puro corre sólo la condición neutra.

## 4. El laboratorio `c302-navigation@1`

### 4.1 El entorno, como servicio

Un servicio propio en Python (`scripts/c302-service.py`, o lanzado por un `.ts` como el de Blender):

- construye la red del panel con c302 y la simula con jNeuroML (Java);
- devuelve las trazas pedidas y las dos señales leídas con el filtro de 200 ms;
- cada petición lleva clave de idempotencia y su respuesta queda en el log de grabación, como `tank` y `particles3d`, así
  que un run reanudado no vuelve a simular;
- corre en local si c302 y Java funcionan en Windows; si no, en la máquina Linux, accedido por HTTP.

### 4.2 Lo que percibe e instrumentos

- **El percepto** es una tabla por episodio:
  - el tiempo;
  - la corriente en cada célula estimulada;
  - las dos señales;
  - y, si el investigador las pide, el calcio de otras células del panel.
- **`act`** pide una simulación con un protocolo del investigador:
  - estímulos de pulso o seno sobre las células sensoriales;
  - qué células registrar;
  - y, como intervención causal, quitar o escalar conexiones o cambiar su polaridad.

  Cuenta contra un presupuesto de `act` por ronda, como en los demás mundos.
- **`view`, `table`, `measure`, `inspect` y `simulate`** funcionan como en los otros mundos de leyes.
- **El cuaderno y, en el asistido, las fuentes, la memoria selectiva y la experiencia** funcionan como siempre.

### 4.3 El modelo

Es el de todos los mundos de leyes:

- observaciones en código sobre el punto: aquí, la historia del estímulo hasta el paso, y lo que el investigador quiera
  medir de ella;
- reglas en palabras que juzga Jev;
- pesos;
- `output`, que devuelve las dos señales en ese paso.

El punto de un caso es un paso de un episodio con su historia, como las filas anteriores en `cells` u `orbit`.

**El coste de Jev** se controla con lo que el arnés ya tiene:

- los checks toman uno de cada N pasos (`--every`), no los 1800;
- puntos que miden lo mismo son una sola pregunta (la caché por observaciones);
- el investigador decide si una regla merece la pena frente a resolverlo en código. Si todo lo resuelve el código, Jev no
  se llama.

La ablación del operador (sólo código frente a Jev frente a juez plano) dice qué aportan las reglas, como en los demás
mundos.

### 4.4 El protocolo

- **Check.** Cada ronda, configuraciones nuevas de la familia vista, generadas por nuestro generador y simuladas en el
  momento. El veredicto, por punto, es la desviación de cada señal frente a lo grabado, en [-1, 1] como en `orbit`; se
  da como hecho.
- **Se sostiene**, según el criterio del operador, cuando la desviación típica de los puntos del check cae por debajo de
  un umbral, en las dos señales y en todos los lugares.
  - El umbral se calibra con dos referencias que no saben nada y que el operador corre aparte: el estímulo promediado y
    el estímulo suavizado.
  - Un modelo que no las supera no se sostiene.
- **Validación** en otros lugares de la familia, cada uno con otra dinámica de la misma ley:
  - la familia de estímulo no vista (periódica y giratoria);
  - con c302, también otras variantes del mismo circuito, como otra semilla de ruido si la hay u otros pesos dentro de
    lo que c302 admite, cuando la ley que se busca debe sobrevivir a ellas.
- **Confirmación ciega**, en dos conjuntos disjuntos de ambas familias que nadie ha visto.
- **Regresión emparejada,** como en los demás mundos: el check anterior se vuelve a responder con el modelo nuevo.

### 4.5 La verdad del operador

- **Las reglas ocultas, en palabras, para nuestro calificador de recuperación (RR).** Son los 18 *insights* de su
  rúbrica, separados en hallazgos y limitaciones. Es la única parte que viene de su problema, y sólo la lee el operador.
- **Las medidas de su evaluación sobre su conjunto de prueba** (§6).

## 5. Condiciones

| | quién | qué recibe | qué mide |
|---|---|---|---|
| **N0 neutra** | el puro, o el asistido sin ayuda | nombres de célula neutros por seed (permutados, con las conexiones también renombradas) y ningún texto de la literatura; la interfaz del simulador sin biología | descubrir sólo con los instrumentos |
| **N1 con nombres** | asistido | los nombres reales de las células y del conectoma, sin el enunciado del fenómeno | el conocimiento del conectoma |
| **N2 encuadre de EurekaBench** | asistido | su enunciado como tarea (`--task`) y una descripción del simulador como fuente | lo más parecido a su condición |

Se pueden cruzar con el senior (Luna con senior Sol) y con la experiencia de otros mundos, siempre como condiciones
declaradas.

## 6. Medidas

- **Nuestro resultado:** checks, validaciones y confirmación ciega; la recuperación de los *insights* (RR); el coste.
- **El método:** la auditoría completa. Aquí hay intervenciones causales sobre el cableado, así que la pregunta de
  controles tiene material.
- **La lectura de EurekaBench (operador).** El modelo aceptado, o el último, responde a sus 100 configuraciones (sólo el
  estímulo, nunca las señales) y se calculan sus medidas, reimplementadas a partir de su descripción:
  - R² conjunto y por señal, por configuración, en la familia no vista y de la parte lenta;
  - la persistencia;
  - el margen sobre sus dos líneas base.
- **Lo que no es comparable, y se dice:**
  - sus líneas base reajustan las constantes del mecanismo con la función del agente, y nuestro modelo no separa
    constantes de estructura; usamos como línea base el mismo modelo con el estímulo reducido, sin reajuste;
  - su PA8 (reajuste con la estructura congelada) no tiene equivalente;
  - si los checks usan uno de cada N pasos, la lectura completa se hace con todos los pasos y Jev cacheado, y se informa
    su coste aparte;
  - sus restricciones e *insights* los juzgan agentes con el simulador; nosotros usamos nuestro calificador sobre el
    cuaderno.

## 7. Coste

- **Simulación.** Por medir (N0): cuánto tarda c302 en simular 9 s del panel de 28 células. Decide cuántas
  configuraciones caben en cada check y si hay que paralelizar el servicio.
- **LLM.** Del orden de un run de otro mundo de leyes: unos $0,10 con Luna o $0,35 con Luna y senior Sol por 10 rondas;
  nada con Qwen local.
- **Jev.** Depende del modelo que construya el investigador:
  - si resuelve todo en código, nada;
  - con reglas, el número de preguntas distintas tras la caché, con N pasos por check.

  La ablación lo deja medido por run, como en `orbit`.

## 8. Plan

- **N0 · Entorno.**
  - Instalar c302 (y pyNeuroML) en un entorno propio fuera del repositorio.
  - Escribir el servicio con idempotencia y log.
  - Medir el tiempo de un run del panel.
  - Reproducir su lectura de señales: comparar nuestras señales con las de su `heldout.npz` en los mismos estímulos.
- **N1 · Generadores.** La familia vista y la no vista según su descripción, con semilla. Comprobar que sus estadísticas
  (amplitudes, anchuras, periodos) caen donde las de `heldout.npz`.
- **N2 · El laboratorio.**
  - Declaración `Lab`: percepto, `act` con cableado, objetivo con veredicto por punto y criterio calibrado con las dos
    referencias.
  - Lugares de la familia y ciegos.
  - Verdad del operador (*insights*) y la lectura de EurekaBench.
  - Pruebas con modelo sustituto y servicio falso, como los demás mundos.
- **N3 · Nombres neutros** para N0: permutación por seed de las células y sus conexiones, en el servicio, de modo que el
  investigador nunca vea un nombre real.
- **N4 · Condiciones.** N0, N1 y N2 con el mismo modelo y presupuesto, réplicas y la auditoría del método.

## 9. Preguntas abiertas

- **El umbral de "se sostiene".** ¿Un margen fijo sobre las dos referencias, o una fracción de lo que logra un modelo de
  referencia? No debe depender de su conjunto de prueba.
- **Qué es la familia aquí.** La familia de estímulo no vista es natural. ¿Hay variantes de c302 (pesos, nivel del
  modelo) bajo las que la ley que se busca deba seguir valiendo, o la ley es propia de este circuito exacto? Si es lo
  segundo, la familia es sólo de estímulos.
- **Cuánto del simulador se expone en N0.** Con nombres neutros, ¿se puede seguir cambiando el cableado? Proponemos que
  sí, con las conexiones renombradas, porque sin intervención causal no se descubre un mecanismo.
- **El paso del modelo.** Las señales son series de 1800 pasos: ¿el punto es cada paso, o un tramo? Lo natural en
  nuestros mundos de leyes es el paso con su historia; queda por ver si Jev aporta algo a ese nivel o el investigador lo
  resolverá en código.
- **Si se traen más problemas de c302** (`biological-networks`, `phase-memory`), el mismo servicio y el mismo laboratorio,
  con otra lectura de señales y otro objetivo, deberían servirlos. Conviene que el servicio no tenga nada propio de
  `navigation-goals`.
