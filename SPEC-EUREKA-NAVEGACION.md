# SPEC · Un problema de EurekaBench como mundo de nuestro arnés: `navigation-goals` (c302)

Estado (05/10/2026): **N0 hecho** (§10): entorno, tiempos, fidelidad del simulador, lectura de las señales decidida y
servicio de c302. Revisada el 04/10: el problema se porta como un mundo que implementa nuestra interfaz de
laboratorio; el arnés no se adapta a su evaluación.

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
  - como intervención causal, quitar o escalar conexiones o cambiar su polaridad;
  - y cambiar parámetros del modelo de c302 (`param_overrides`). Sin esto no se puede descubrir I11 ("lo que el gusano
    aprendió del olor cambia las reglas de cambio"); su simulador lo permite y el nuestro también debe.

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

## 10. N0 hecho (04–05/10/2026)

**El entorno.**

- La copia de EurekaBench está en `D:\OctaneDoc\OctLocalServer\EurekaBench`, fuera del repositorio.
- Su `.venv` tiene Python 3.12 con las versiones que fijan: c302 en su commit, pyNeuroML 1.3.22, libNeuroML 0.6.7,
  PyLEMS, neuromllite, cect y wormneuroatlas, más numpy 1.26 y scipy.
- Java 11. **c302 corre en Windows.**

**Tiempos** (una configuración de 9 s, `dt` 0,05 ms):

| red | tiempo |
|---|---|
| panel de 28 células | unos 93 s |
| el mismo panel con 6 simulaciones a la vez | 120–140 s cada una (16 núcleos) |
| la red completa de 302 células | 51 minutos (además escribía 1,2 GB en disco, porque el ejecutor de prueba registraba cada paso de integración) |

**Fidelidad del simulador.**

- Su `simulator.py`, ejecutado en local y sin copiarlo, y nuestro ejecutor dan **el mismo calcio** en todas las células
  con el mismo estímulo: diferencia 0,0, la misma red (204 conexiones).
- La red completa no explica su conjunto de prueba; encaja peor que el panel.
- Su tiempo de construcción (1932 s con 6 procesos para 100 configuraciones) también cuadra con el panel.

**Su lectura de las señales.** El script con el que generaron el conjunto de prueba no está publicado. Re-simulamos 10 de
sus protocolos (5 de cada familia) y comparamos:

- **Reorientación:** AVA − AVB, filtrada **dos veces** con el filtro causal de 200 ms. Su enunciado lo deja entrever: el
  simulador lee la señal con ese filtro "y la evaluación la lee de la misma manera".
  - Correlación 0,96 por configuración y R² 0,93 con una sola transformación lineal para todas (unos 1,2 × 10⁸ más un
    pequeño desplazamiento).
  - Persistencia de 215 / 265 ms (familia vista / no vista) frente a 175 / 200 ms las suyas.
  - Casi el mismo número de cruces del punto medio por configuración.
  - **Conclusión: equivalente.**
- **Giro:** no lo reproducimos.
  - RIAL − RIAR, con normalización por célula, llega a una correlación de 0,5–0,7.
  - Ni RIA ni ninguna combinación lineal de las 28 células del panel lo explican (R² 0,65 fuera de muestra).
  - Puede leer otra magnitud (voltaje) o algo no lineal.
  - **Conclusión: no equivalente.** Su propio mecanismo de referencia sólo logra R² 0,17 en el giro.

**Decisiones.**

- **La lectura del mundo:**
  - reorientación = AVA − AVB del calcio, filtrada dos veces a 200 ms;
  - giro = RIAL − RIAR, filtrado igual.

  Están documentadas como nuestras. La de giro declara que no es la suya.
- **La lectura de EurekaBench del operador:** sus 100 protocolos re-simulados con nuestro servicio. Las medidas de
  reorientación se consideran comparables con las suyas; las de giro, no.
- **Los *insights* se pueden obtener con nuestro laboratorio.** Hablan del circuito, que es el mismo, y el investigador
  puede registrar cualquier célula del panel, cambiar el cableado y los parámetros, y repetir.
  - Sobre el estado que persiste, sus dos valores, la dirección del cambio, los regímenes y las neuronas que lo sostienen
    (I1, I2, I4, I9, I10, I13–I18): equivalentes.
  - Sobre ir hacia el olor (I3, I5, I7, I12): c302 no tiene cuerpo ni gradiente, así que se derivan razonando desde el
    mecanismo, igual que su juez.
  - Sobre comparar las dos acciones (I6, I8): obtenibles por el registro directo de RIA, aunque nuestra señal de giro no
    sea la suya.
  - I11: requiere `param_overrides` en el `act` (§4.2).
- **El servicio** (hecho, 05/10) es genérico de c302, no de `navigation-goals`.
  - Partes: `lib/src/worlds/c302/service.ts` y `simulate.py`; se arranca con `scripts/c302-service.ts --python <python con
    c302>`.
  - `POST /simulate` simula una red con estímulos (pulso o seno), cambios de cableado (quitar, escalar, cambiar la
    polaridad) y de parámetros (`param_overrides`), y devuelve el calcio de las células pedidas cada 5 ms.
  - Una clave de idempotencia hace que se simule una vez; pedida otra vez mientras corre, espera a la misma simulación.
  - Simula hasta `--concurrency` a la vez, un proceso Python por petición.
  - `GET /stats` dice cuántas simulaciones corrió y cuántas veces respondió de nuevo.
  - La lectura de las señales es del laboratorio.
  - Comprobado con c302 real: la configuración 0 da el mismo calcio que antes, y una simulación con seno, conexión
    cortada, conexión escalada y un parámetro cambiado funciona (203 conexiones). Tardaron 113–161 s con dos a la vez.
  - Pruebas: `lib/test/c302-service.test.ts`, con un trabajador sustituto.

## 11. N1 hecho (05/10/2026): las dos familias de estímulo

Medidas sobre sus 100 protocolos (67 de la familia vista y 33 de la no vista) y reproducidas en
`lib/src/worlds/c302nav/stimuli.ts`, con semilla. Ninguna línea de su código: sólo lo que describen y lo que se mide en
los estímulos.

**`steps` (la vista):**

- trenes irregulares; cada pulso sortea por su cuenta:
  - anchura en {60, 120, 200, 320, 400} ms;
  - separación hasta el siguiente en {100, 200, 400, 700, 900} ms;
  - total en {2,5; 3,5; 4,5; 5,5; 6} pA;
  - reparto izquierda/(izquierda + derecha) en {0; 0,25; 0,5; 0,75; 1};
- el primer pulso, a 200, 350 o 500 ms;
- siguen hasta el final del run (el último termina a 8985 ms como mucho).

**`rotating` (la no vista):**

- en cada run, una anchura en {150, 250, 350} ms y un periodo en {500, 700, 900, 1200} ms;
- el primer pulso a 200 ms;
- el total gira como 3,25 + 2,75·cos(2πt/T + φ), con T en {2000, 3000, 4500} ms;
- el reparto gira como 0,5 + 0,45·cos(2πt/T' + φ'), con T' ≈ 1,43·T;
- las fases son al azar;
- el último pulso termina a 8900 ms como mucho. Con esta regla coinciden sus 33 protocolos; con el final del run, sólo
  24.

**Comparación (400 protocolos nuestros frente a los suyos):**

| | pulsos por run | fracción de tiempo con corriente |
|---|---|---|
| `steps` | 8–18, mediana 13 (suyos: 10–18, mediana 13) | 0,316 (suyos: 0,311) |
| `rotating` | 7–18 (suyos: 7–18) | 0,343 (suyos: 0,341) |

Anchuras, separaciones, totales y repartos tienen exactamente los mismos conjuntos de valores.

**Una diferencia que no reproducimos:**

- Algunos de sus pulsos no caen en la rejilla de 5 ms: aparecen anchuras de 55 y 65 ms.
- Los nuestros empiezan en múltiplos de 5 ms.
- Es una de las razones posibles de que sus señales no se reconstruyan al número (§10), y no cambia la familia.

Pruebas: `lib/test/c302nav-stimuli.test.ts`.

**Siguiente (N2):** el laboratorio `c302-navigation@1`.

## 12. N2 hecho (05/10/2026): el laboratorio `c302-navigation@1`

Declarado como cualquier otro mundo de leyes, en `lib/src/worlds/c302nav/` (`world.ts`, `objective.ts`, `interface.ts`,
`lab.ts`), y registrado como `--lab c302nav`. El arnés no cambia salvo en una cosa genérica: un laboratorio externo puede
declarar cuánto puede tardar una petición (`external.timeoutMs`). Aquí son 40 minutos, porque una simulación tarda minutos
y puede esperar en la cola del servicio.

**Lugares.**

- El laboratorio (`lab1`) toma sus episodios de la familia vista (`steps`).
- Los lugares de la familia, de la no vista (`rotating`): validar es pasar a la otra dinámica de estímulo.
- Los ciegos, de una u otra por turnos.
- Cada lugar tiene su semilla; cada episodio sortea la suya y simula su protocolo.

**El percepto.** En un punto, el código recibe `p = { step, t, inputs }`: los tiempos y la corriente en cada célula
estimulada hasta ese paso, nada después. No ve las señales pasadas: el modelo responde desde el estímulo, como el suyo.
`view` muestra hasta 60 filas: el tiempo, las corrientes, las dos señales y el calcio de las células registradas (en
unidades de 1e-8 mM, como las señales).

**El objetivo.**

- La respuesta: `{reorientation, steering}` en ese paso.
- El veredicto, por punto y señal: tanh((lo que vino − la respuesta) / s), con s la desviación típica de esa señal en el
  episodio. Es un hecho; qué significa el resto del rango lo averigua el investigador.
- Se sostiene en un lugar cuando el R² de cada señal, sobre todos los puntos del lugar, llega al umbral del operador
  (`--hold-r2`, por defecto 0,5 para reorientación y 0,3 para giro) y ningún punto falla. Con la regresión emparejada,
  también en el check anterior.
- Líneas base del operador: "nada se mueve" (ceros) y "el estímulo ahora". Si una se sostiene, el check no distinguía.

**El `act`.**

- Estímulos de pulso o seno en cualquier célula del panel, qué células registrar, quitar, escalar o cambiar de signo
  conexiones (`"PRE-POST"` o `"PRE-POST_GJ"`), parámetros del modelo por nombre (`param_overrides`, lo que pide I11) y
  duración de hasta 9 s.
- O `{"wiring": true}`: las conexiones entre las células del panel, con su tipo, transmisor y número de contactos. Es
  una ruta nueva del servicio, `POST /wiring`, genérica de c302.
- La forma se comprueba antes de pedirlo y se explica el error. Si el servicio lo rechaza, el investigador sólo sabe que
  fue rechazado, como en los demás mundos.

**Coste en tiempo.** Las simulaciones que se piden juntas (la exploración, los episodios de un check) se piden a la vez;
las claves de idempotencia siguen el orden en que se sortearon, así que un run reanudado las reproduce. Con los valores por
defecto (`--every 20`, `--explore 3`, `--check-episodes 2`, `--family 2`, `--confirm-places 1`, `--acts 2`), cada punto
de check es uno de cada 20 pasos (91 por episodio).

**La verdad del operador.** Con `--eureka <copia local de EurekaBench>` se leen los 18 *insights* de su rúbrica (con su
tipo, hallazgo o limitación) para el calificador. No se copia nada al repositorio; sin esa opción, no hay calificación de
recuperación y nada más cambia.

**Lo que no se ha hecho aún:**

- **La lectura de EurekaBench** (sus 100 configuraciones re-simuladas y sus medidas, §6). Es del operador y no la
  necesita el run; va con N4.
- **El umbral calibrado con referencias** (§9). Por ahora es un R² fijo por señal; se calibrará en N4 con los modelos de
  referencia sobre episodios nuestros, nunca sobre su conjunto de prueba.
- **Equipos** (`--team`): no se declaran para este mundo; con simulaciones de minutos, primero los runs individuales.

**Comprobado.**

- Pruebas en `lib/test/c302nav-lab.test.ts`, con un trabajador sustituto en el servicio real:
  - la lectura de las señales;
  - la forma del `act` y del cableado;
  - que la interfaz no dice nada de la biología;
  - un run completo, que se reanuda sin volver a simular: exploración, `act`, check, validación en la familia no vista y
    confirmación ciega, con un modelo que reproduce al sustituto (R² 1).
- Con c302 real: un episodio de `steps` y el cableado, pedidos a la vez, tardaron 103 s.
  - La reorientación va de 0 a 7,2 (media 2,1, desviación 1,8); el giro, de −3,3 a 0,3.
  - El calcio entre pulsos es del orden de 1e-12 mM y sube varios órdenes durante ellos. Por eso las señales quedan en
    unidades de orden 1.
  - El cableado del panel tiene 204 conexiones, las mismas que se midieron en N0.

**Siguiente:** N3 (nombres neutros), luego N4.

## 13. N3 hecho (05/10/2026): nombres neutros

`--names neutral` (por defecto `real`). El investigador nunca ve un nombre real: ni en el prompt, ni en un episodio, ni
en la respuesta de un `act`, ni en el cableado.

**Cómo se nombra.**

- **Células:** las 28 del panel son `C01`…`C28`, con una permutación sorteada de la seed del run. Es la misma en todos los
  lugares del run, y otra seed da otra. Los pares izquierda/derecha no se delatan por el nombre.
- **Conexiones:** se nombran por sus células neutras (`C07-C19`, `C07-C19_GJ`).
- **Transmisores:** en el cableado, `T1`…`T8`, también sorteados. El signo de cada uno lo averigua el investigador
  (cambiando polaridades, por ejemplo).
- **Señales:** `s1` (reorientación) y `s2` (giro). Así se llama también la respuesta: `{"s1": …, "s2": …}`.
- **El cableado,** ordenado por nombre neutro: el orden de c302 delataría los nombres reales.

**Dónde se traduce.** En la frontera del laboratorio (`namingOf` en `world.ts`, `realAct` en `lab.ts`).

- El servicio sigue siendo genérico y recibe siempre nombres reales.
- Un `act` que nombra algo que este run no tiene (un nombre real en modo neutro, por ejemplo) se rechaza sin decir por
  qué, como cualquier otro rechazo.
- Los parámetros del modelo (`param_overrides`) no se traducen: la interfaz no nombra ninguno, así que el investigador
  sólo los conoce si los descubre o, en el asistido, por una fuente.

**El operador.**

- El glosario (qué es cada nombre neutro) queda en la parte oculta del journal.
- Se da al calificador como `learner_names`, también al recalificar.
- Para eso hay dos añadidos genéricos al arnés:
  - `Lab.grading.glossary`;
  - `Lab.interface` recibe las opciones del mundo (`world`), porque sus palabras dependen de ellas.

  `orchestra/reader.ts` las reconstruye de la configuración del journal.

**Lo que no se oculta, y es una decisión.** La interfaz sigue hablando de células, calcio, conexiones químicas y uniones
gap, corrientes en pA y una red simulada. Se ocultan las identidades (qué célula es cuál, qué hace cada una en la
literatura), no el tipo de sistema. Ocultar también eso exigiría otro vocabulario para el `act` y el cableado; queda como
variante si N4 lo pide.

**Comprobado** (`lib/test/c302nav-lab.test.ts`):

- **La permutación:**
  - es biyectiva;
  - otra seed da otra;
  - la traducción de conexiones va y vuelve;
  - un nombre real no existe en modo neutro.
- **Un episodio, un `act` y el cableado** no contienen ningún nombre real, ni el de un transmisor ni el de una señal.
- **Al servicio** se le pide en nombres reales.
- **Un run completo en modo neutro:** ningún mensaje enviado a System 2 contiene un nombre real. Un modelo escrito en sus
  nombres (`s1`, `s2`, `C..`) se sostiene, y el glosario queda en el journal.

**Siguiente:** N4 (condiciones, runs y la auditoría del método), con la lectura de EurekaBench del operador y el umbral
calibrado (§12).
