# SPEC · Un problema de EurekaBench en nuestro arnés: `navigation-goals` (c302)

Estado (04/10/2026): **propuesta, sin implementar.**

Contexto: [EurekaBench](https://github.com/EurekaBench/EurekaBench) (Geng et al., 2026) evalúa agentes de código que
descubren mecanismos con simuladores científicos. De sus 24 problemas, los de la clase "simulador como mundo" son los que
encajan con nuestro arnés (ver el análisis de la conversación del 04/10). `navigation-goals` es el primero porque tiene la
interfaz más simple (el modelo sólo recibe el estímulo), 8 criterios automáticos y un simulador que corre en CPU.

## 1. Para qué

- **Validación externa.** Medir nuestro investigador en un problema que otros han diseñado, con su evaluación sin tocar,
  frente a su mecanismo de referencia y a los agentes que publiquen.
- **Una pregunta que nuestros mundos no permiten.** El mismo simulador con y sin el encuadre de la literatura: cuánto del
  resultado viene de descubrir con los instrumentos y cuánto de lo que el modelo ya sabe de *C. elegans* (condiciones de
  §5, como las A/B/C del mundo 3D).
- **El método, que ellos no miden.** Guardan la trayectoria pero no la puntúan; nuestra auditoría del método se aplica
  tal cual (SPEC-AUDITORIA-METODO).

No sustituye a nuestros mundos generados: aquí el modelo puede saber de antemano parte de la respuesta. Es otra condición,
declarada y separada.

## 2. El problema

**Lo que se descubre es el comportamiento de c302**, el modelo del sistema nervioso de *C. elegans* de OpenWorm, no la
biología. Dos señales de acción, leídas por el simulador con un filtro causal de 200 ms del calcio (`caConc`):

- **reorientación** = media de `AVAL`, `AVAR` menos media de `AVBL`, `AVBR`;
- **giro (steering)** = `RIAL` menos `RIAR`.

**La entrada** es sólo la corriente inyectada en las dos neuronas olfativas `AWCL` y `AWCR` (2,5 a 6 pA, 9 s, nivel `C1`,
`dt` 0,05 ms, muestreo cada 5 ms), sobre un panel de 28 células: sensoriales, primera capa (AIA, AIB, AIY, AIZ),
integrador (RIA), núcleo (RIM, AVE, RIB), mando (AVA, AVB) y motoras de la cabeza.

**Lo que hay que explicar:**

- qué decide, en cada momento y sobre qué historia del estímulo, cuál de las dos acciones produce el mismo estímulo y con
  qué fuerza;
- qué arrastra esa decisión de una muestra a la siguiente;
- qué termina una racha de reorientaciones.

Su referencia (rúbrica de *insights*) apunta a un estado que persiste, con dos valores discretos y cambios que dependen de
la dirección en que cambia el estímulo.

**Familias de estímulo:**

- **vista:** trenes irregulares de pulsos cuadrados, con anchura, separación, total y reparto entre lados sorteados cada
  uno por su cuenta;
- **no vista:** trenes periódicos de anchura y periodo fijos, con el total y el reparto girando suavemente a lo largo del
  run. Es un tercio de su conjunto de prueba, y el agente nunca la ve.

**Su evaluación** (`tests/evaluate.py`), sobre 100 configuraciones precalculadas (`heldout.npz`), compara las dos señales
predichas con las grabadas:

| criterio | qué mide |
|---|---|
| PA1–PA3 | R² conjunto, y de cada señal por separado |
| PA4 | R² por configuración (mediana y fracción por debajo de cero) |
| PA5 | persistencia: cuánto mantiene su valor la reorientación predicha frente a la grabada (semivida de la autocorrelación) |
| PA6 | R² en la familia no vista |
| PA7 | R² de la parte lenta de la reorientación (más lenta que 2 s) |
| PA8 | R² con las constantes reajustadas por el propio `fit_coeffs` en la mitad de las configuraciones y la estructura congelada |

Cada criterio se puntúa **por encima de dos líneas base reducidas**, cada una reajustada antes con el `fit_coeffs` del
agente: el mismo mecanismo con el estímulo sustituido por su media (sin dinámica) y con el estímulo suavizado a 3 s.

Su mecanismo publicado da un R² conjunto de 0,59 (0,47 en reorientación y 0,17 en giro).

**Además**, con jueces LLM, hay 5 restricciones científicas que actúan como compuerta y 18 *insights* (12 hallazgos y
6 limitaciones). La nota global es (PA + insights) / nº de criterios si se cumplen todas las restricciones, y 0 si no.

## 3. Principios

- **E1. Su evaluación, sin tocar.** La nota comparable con EurekaBench es la de su `evaluate.py` sobre su `heldout.npz`.
  Nada de nuestro protocolo lee ese conjunto: es el examen final, como nuestra confirmación ciega.
- **E2. Su código y sus datos no entran en el repositorio.** El repositorio no declara licencia. El arnés lee una copia
  local que el operador descarga (`--eureka <ruta>`) y nunca copia de ella al repositorio ni a los journals más que las
  medidas que produce.
- **E3. Decide el mundo, como siempre.** El investigador nunca recibe una métrica: recibe lo que el simulador grabó y lo
  que su modelo respondió, y calcula lo demás él. Lo que se le enseña es el registro, no un R².
- **E4. Condiciones declaradas.** El encuadre de la literatura es ayuda y va en el journal y en el finding. El
  investigador puro sólo corre la condición neutra (§5).
- **E5. Un solo artefacto.** El modelo del investigador es directamente el `mechanism.py` de su contrato: lo que nuestros
  checks evalúan es exactamente lo que su evaluación evalúa. No hay traducción entre lenguajes.

## 4. El laboratorio `c302-navigation@1`

### 4.1 El entorno, como servicio

c302 corre con Java (jNeuroML) y pyNeuroML. Como `tank` y `particles3d`, el simulador vive en un proceso propio
(`scripts/c302-service.ts` lanzando su `simulator.py`, o un servicio Python mínimo):

- las peticiones llevan clave de idempotencia y cada respuesta queda en el log de grabación, así que un run reanudado no
  vuelve a simular;
- si no corre en Windows, el servicio se levanta en la máquina Linux (la de vLLM) y el arnés le habla por HTTP.

### 4.2 Lo que percibe e instrumentos

- **El percepto** es una tabla por episodio: tiempo, la corriente en cada célula estimulada, las dos señales y, si el
  investigador las pidió, el calcio de otras células del panel.
- **`act`** pide una simulación con un protocolo del investigador. Admite lo mismo que su `simulate_network`:
  - estímulos de pulso o seno sobre las células sensoriales;
  - las células a registrar;
  - quitar o escalar conexiones, cambiar su polaridad, y otros niveles del modelo.

  La intervención sobre el cableado es lo que permite contrastar hipótesis causales (qué célula sostiene el estado), y es
  donde nuestra auditoría puede ver controles reales. El número de `act` por ronda es un presupuesto, como en los otros
  mundos.
- **`view`, `table`, `measure` e `inspect`** funcionan como siempre sobre las tablas de los episodios.
- **`simulate`** corre el modelo del investigador sobre un estímulo cualquiera, sin el entorno.
- **El cuaderno, las fuentes, la memoria selectiva y la experiencia** son los del asistido, según la condición.

### 4.3 El modelo: su contrato, en Python

En este laboratorio el modelo no es una fórmula con reglas que juzga Jev (§8 explica por qué). Es el fichero de su
contrato:

- `INPUTS` y `COEFFS`, este último con las constantes ajustadas;
- `predict_reorientation(props, coeffs)` y `predict_steering(props, coeffs)`, que devuelven (N, T);
- `fit_coeffs(props, signals, coeffs_init)`, que reajusta sólo las constantes.

Las reglas son las suyas: determinista, sólo numpy y scipy, causal (en cada paso sólo lee pasos anteriores), sin tablas de
búsqueda ni componentes aprendidos, y con límites de tiempo.

El arnés lo ejecuta en un **trabajador Python aislado**: sin red, con tiempo y memoria limitados y con una comprobación
estática de importaciones y lectura de ficheros, como la suya. Lo hace tanto para nuestros checks como para `simulate` e
`inspect`.

Esto es una capacidad nueva del núcleo, el **modelo en Python**. Hoy el código del modelo es JavaScript evaluado en una VM
de Node. Quedaría restringida a los laboratorios que la declaren.

### 4.4 El protocolo

- **Check.** Cada ronda, unas pocas configuraciones nuevas de la familia vista, generadas por nuestro generador y
  simuladas en el momento. El veredicto, por configuración, es lo grabado frente a lo respondido, paso a paso, como hecho.
- **Se sostiene** si, sobre el check, el R² conjunto supera a las dos líneas base reducidas (estímulo medio y estímulo
  suavizado, reajustadas con su `fit_coeffs`) por un margen del operador. Es el mismo criterio de su evaluación, aplicado
  a casos nuestros. El umbral concreto queda abierto (§9).
- **Validación** en la familia no vista: periódica y giratoria. Su generador no está en el repositorio (el conjunto de
  prueba viene precalculado), así que escribimos el nuestro según la descripción de su `manifest.json`. Cubre su PA6.
- **Confirmación ciega**, en dos conjuntos disjuntos de ambas familias.
- **Al final** (o cuando el modelo se acepta), su `evaluate.py` sobre su `heldout.npz`.

### 4.5 Lo que se entrega

| entregable | de dónde sale |
|---|---|
| `mechanism.py` | el modelo aceptado, o el último si no se aceptó ninguno, tal cual |
| `mechanism.md` | una ronda final de informe: el investigador escribe la cadena causal, qué persiste y qué lo mueve, y su evidencia y las alternativas rechazadas, citando sus pasos y episodios, con la misma estructura que piden |
| `experiment.log` y evidencias | el cuaderno del investigador y su registro en la vista del investigador (creencias, notas, métodos, cada investigación con lo que respondió el mundo), exportados de forma mecánica, más las tablas que citó |

La nota de su evaluación (PA1–PA8) entra en el finding del operador junto a nuestras medidas, sin combinarse.

## 5. Condiciones

| | quién | qué recibe | qué mide |
|---|---|---|---|
| **N0 neutra** | el puro o el asistido sin ayuda | nombres de célula neutros por seed (permutados), sin texto de la literatura; la interfaz del simulador descrita sin biología | descubrir sólo con los instrumentos |
| **N1 con nombres** | asistido | los nombres reales de las células y la descripción de c302, sin el enunciado del fenómeno | el conocimiento del conectoma |
| **N2 EurekaBench** | asistido | su enunciado como tarea (`--task`) y su guía del simulador como fuente | lo más parecido a su condición |

Se pueden añadir el senior (Luna con senior Sol) y la experiencia de otros mundos como condiciones aparte.

La comparación limpia es dentro de nuestro arnés (N0 frente a N1 frente a N2, con el mismo modelo y presupuesto). La
comparación con EurekaBench es sólo con N2, y con su mismo límite de tiempo: 4 h de reloj, `--max-minutes 240`.

Con N0, su nota sigue siendo válida (la evaluación sólo lee el estímulo y las dos señales), pero sus jueces de *insights*
esperan un vocabulario biológico. N0 se compara sólo por PA, la auditoría y nuestra validación.

## 6. Medidas

- **Su nota.** PA1–PA8 con su `evaluate.py`, gratis y automática. Restricciones e *insights* con sus jueces, opcional y
  caro: necesitan un agente con acceso al simulador.
- **Nuestro resultado.** Checks, validación en la familia no vista y confirmación ciega.
- **Una recuperación tipo RR, sólo del operador.** Los 18 *insights* de su rúbrica como enunciados de verdad para nuestro
  calificador, separando hallazgos y limitaciones. Es la lectura más cercana a "encontró el mecanismo" sin sus jueces con
  simulador.
- **El método.** La auditoría completa. Aquí sí hay intervenciones causales sobre el cableado, así que la pregunta de
  controles (J6) tiene material.
- **Coste.** Tokens del LLM, tiempo de simulación y reloj.

## 7. Coste

- **Simulación.** No está medido. Un run de 9 s del panel de 28 células a `dt` 0,05 ms es el dato que decide el tamaño de
  los checks (fase N0 del plan).
  - Si tarda un minuto, un check de 4 configuraciones más una regresión son unos 8 minutos por ronda, y 4 h dan para unas
    15 rondas con margen para las simulaciones del investigador.
  - Si tarda mucho más, hay que bajar el número de configuraciones o paralelizar el servicio.
- **LLM.** Del orden de un run de la cuadrícula: unos $0,10 con Luna o $0,35 con Luna y senior Sol por 10 rondas; con
  Qwen local, nada.
- **Jev.** Ninguna llamada, porque el modelo es código, salvo la auditoría (unas 40 llamadas por run).
- **Sus jueces,** si se usan: un agente por juez con acceso al simulador, del orden de un run de agente; a decidir aparte.

## 8. Lo que este laboratorio deja fuera de nuestro diseño

- **Jev no participa en el modelo.** Su contrato prohíbe componentes aprendidos y exige reproducirse en 2 minutos sobre
  100 configuraciones de 1800 pasos. Un juez por paso es inviable y está prohibido. Es la variante de sólo código de
  nuestros mundos de leyes, y hay que decirlo al comparar: aquí no se mide la parte neurosimbólica del arnés.
- **El modelo es Python, no JavaScript.** Es la única manera de que lo que comprobamos sea lo que ellos evalúan (E5).
- **El conocimiento previo no se puede eliminar** en N1 y N2, sólo medir por comparación con N0.

## 9. Plan

- **N0 · Entorno.**
  - Copia local de EurekaBench; c302, pyNeuroML y Java.
  - El servicio del simulador con idempotencia y log.
  - Medir el tiempo de un run del panel.
  - Comprobar que su `evaluate.py` corre sobre el `mechanism.py` de referencia, o sobre uno trivial, y reproduce sus
    líneas base.
- **N1 · Generadores.** La familia vista y la no vista según su manifiesto, con semilla. Comprobar que sus estadísticas
  (amplitudes, anchuras, periodos) caen donde las de `heldout.npz`.
- **N2 · Modelo en Python.** El trabajador aislado, la comprobación estática, `simulate` e `inspect` sobre él, y el
  criterio con las dos líneas base.
- **N3 · El laboratorio.**
  - Percepto, `act` con cableado, checks, validación y ciegas.
  - La ronda de informe y la exportación de los tres entregables.
  - Su `evaluate.py` al final, con la nota en el finding.
- **N4 · Condiciones.** N0, N1 y N2 con el mismo modelo, réplicas y la auditoría del método.
- **N5 (opcional).** Sus jueces de restricciones e *insights* sobre la condición N2.

## 10. Preguntas abiertas

- **El umbral de "se sostiene".** ¿Un margen fijo sobre las líneas base, o la fracción de su referencia (0,59)? No debe
  depender de su conjunto de prueba.
- **Las constantes.** Su contrato no fija un máximo en este problema; en otros es 10. ¿Imponemos uno para que la
  estructura y no las constantes lleve el mecanismo (PA8)?
- **Cuánto del simulador se expone en N0.** Con nombres neutros, ¿el investigador puede seguir cambiando el cableado?
  Proponemos que sí, con las conexiones también renombradas, porque sin intervención causal no hay descubrimiento de
  mecanismo.
- **Si su generador difiere del nuestro,** nuestra validación en la familia no vista puede no anticipar su PA6. Se verá
  en N1 comparando estadísticas.
- **Si aparecen más problemas de c302** (`biological-networks`, `phase-memory`), el mismo laboratorio, con otra lectura
  de señales y otra interfaz, debería servirlos con poco trabajo. Conviene diseñar el servicio y el modelo en Python sin
  nada propio de `navigation-goals`.
