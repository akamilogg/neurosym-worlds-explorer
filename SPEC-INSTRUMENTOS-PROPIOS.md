# SPEC · Instrumentos propios: el investigador escribe las herramientas con que analiza sus datos

Estado: implementado en los mundos de leyes y en la cuadrícula (13/10/2026, §13 y §14).

## 1. De dónde sale

En todos los runs de lazo cerrado (`c302closed-n2-4`, `n2-5`, `n2-7`, `staged-n2`, `staged-n2-3`) el R² del check no pasó de
~0,35, con distintos modelos, métodos, seniors y esfuerzos de razonamiento. El cuello de botella es siempre el mismo:
**ajustar los parámetros de un modelo dinámico**.
- El junior escribe un modelo con números dentro (`0.82`, `430 ms`, `265 ms`…) y sólo puede cambiarlos a mano: propone,
  espera al check y vuelve a leer trazas.
- En `staged-n2-3` hizo 83 `view` y ninguna `measure` ni `table`. En `n2-5`, 66 `view` y 2 `measure`.
- Su error oscila de ronda en ronda sin tendencia, porque nunca lo mide sistemáticamente contra sus datos.

La primera idea fue un instrumento `fit` del entorno: el investigador da su código con parámetros libres y el entorno
devuelve los valores que mejor ajustan. El autor la descartó (13/10/2026): un ajuste escrito en el entorno es análisis
hecho por el entorno. Lo ideal es que, en los entornos que ofrecen una API o un sandbox de código, **el investigador
escriba y registre sus propios instrumentos**, y que se ejecuten en ese entorno. El entorno sólo pone las primitivas.

## 2. Principios

- **El entorno da primitivas, el análisis es del investigador.** Ni siquiera "ajustar", "correlacionar" o "resumir"
  vienen hechos: los escribe él. Es la regla de siempre, sin investigación precocinada, llevada a sus herramientas.
- **Analizar no es observar.** Un instrumento trabaja sobre lo ya observado: sus episodios, sus checks, sus modelos.
  Observar algo nuevo sigue siendo `act`, con su presupuesto. Un instrumento nunca pide episodios ni llama al servicio
  del entorno.
- **Reproducible.** La misma llamada da el mismo resultado: sandbox sin red ni ficheros, aleatoriedad con semilla fija,
  topes de tiempo y memoria. Así el run se puede repetir y reanudar.
- **El veredicto no cambia.** Un modelo afinado con sus instrumentos se juzga igual: checks con episodios nuevos,
  validación por familia y confirmación a ciegas. Si ajusta de más a sus datos, el check lo detecta.
- **Auditable.** Cada instrumento, cada versión y cada uso quedan en el diario. El senior y la auditoría ven cómo llegó a
  cada número.

## 3. Qué es un instrumento, y en qué se distingue de una observación

| | Observación (del modelo) | Instrumento propio (del método) |
|---|---|---|
| Pertenece a | la **respuesta**: el modelo propuesto y su huella | la **investigación**: su cuaderno y su diario |
| Recibe | un punto (`p`: lo que el percepto da hasta ahora) | sus datos: episodios, puntos, modelos, y argumentos |
| Devuelve | un valor que alimenta la predicción | un resultado para él: parámetros, tablas, un diagnóstico |
| Lo juzga | el check, con episodios nuevos | nadie: es su herramienta y su responsabilidad |
| Lo ejecuta | el entorno, en cada punto que evalúa | el entorno, cuando el investigador lo usa |

`measure` y `table` son un caso particular, y ya existen: evalúan código del investigador punto a punto y devuelven los
valores. Un instrumento propio generaliza eso. El investigador escribe también el bucle, el cálculo y la forma de lo que
devuelve.

## 4. Las peticiones

**Registrar** (o volver a registrar: una versión nueva) un instrumento, como petición de investigación:

```json
{"register_instrument": {"id": "fit_kernel", "about": "least squares of my kernel model over episodes I name",
  "source": "(args, env) => { /* su optimizador, su regresión, lo que necesite */ return { params, error_by_episode }; }"}}
```

**Usarlo**, en cualquier ronda posterior, con argumentos:

```json
{"use": "fit_kernel", "args": {"on": ["act3", "act7", "check2-lab1-1"], "start": {"tau": 300}}}
```

- **Registrar** comprueba que el código compila y lo guarda con una versión (`fit_kernel@2`). No lo ejecuta.
- **Usar** ejecuta la última versión, o una concreta (`"use": "fit_kernel@1"`), y devuelve lo que el código devuelva,
  dentro de los topes (§6). Si falla, se devuelve el error, como cuando falla una observación.
- **Listar y leer** sus instrumentos va por la memoria selectiva: clase `instruments`, ids `instrument:<id>`.

## 5. La API del entorno (`env`)

Sólo primitivas de lectura y evaluación sobre lo que el investigador ya tiene. La de un mundo de leyes, como
c302closed:

| Primitiva | Devuelve |
|---|---|
| `env.episodes()` | el índice de sus episodios (ids, lugar, ronda, quién lo pidió) |
| `env.points(ref)` | los puntos de un episodio o de un tramo (`"act3"`, `"act3@100-200"`, `"check2-lab1-1"`), cada uno con su percepto `p` |
| `env.came(ref)` | lo que el entorno respondió en esos puntos (las señales que salieron) |
| `env.answer(model, points)` | lo que un modelo suyo (`model: <ronda>`) o un borrador de código responde en esos puntos |
| `env.random(seed)` | un generador determinista |

**No hay** funciones de análisis (`fit`, `mean`, `correlate`, `r2`): las escribe él, en su código o como otro instrumento.

**Cada mundo declara su API** con el mismo patrón:
- **La cuadrícula:** partidas y posiciones en lugar de episodios de señales; `answer` evalúa una fórmula suya en
  posiciones.
- **Un entorno sin sandbox de código** (una API externa): sólo la lectura de sus datos, y el código corre en el sandbox
  del arnés.

La interfaz de cada laboratorio la documenta en su sección del prompt, como ya hace con su percepto.

## 6. Límites

- **Sólo lo ya observado:** sus episodios y los puntos de sus checks. Nunca los episodios de la familia ni de la
  confirmación a ciegas.
- **Sin experimentos:** un instrumento no puede llamar a `act`, a la simulación ni al servicio.
- **Sin Jev:** `env.answer` rechaza un modelo con reglas de Jev. En un bucle sería caro y no determinista.
- **Topes por uso:**
  - tiempo de CPU (p. ej., 30 s);
  - memoria;
  - número de evaluaciones de `env.answer`;
  - tamaño de la respuesta (p. ej., 20.000 caracteres). Si se pasa, se recorta y se le dice.
- **Coste:** cada `use` gasta un paso de investigación. Registrar no gasta, como escribir una nota.
- **Determinismo:** sin `Date`, `Math.random` sin semilla, red ni ficheros. El mismo uso, con los mismos datos, da el
  mismo resultado.

## 7. Registro, repetición y auditoría

- **El diario guarda:**
  - cada versión registrada (`instrument_registered`: id, versión, código, `about`);
  - cada uso (`instrument_used`: versión, argumentos, resultado o error, tiempo).
- **Al repetir un run,** los usos se vuelven a ejecutar, porque son deterministas sobre los mismos datos. No pasan por el
  registro de respuestas de la red. Si un resultado repetido difiere del grabado, es un fallo del sandbox, y el run lo
  registra.
- **El finding** lista sus instrumentos (`assistance.instruments`: id, versiones, usos).
- **El senior** ve en su resumen los instrumentos registrados en cada ronda y sus usos, y puede abrirlos. Su papel ya le
  pide revisar cómo se llegó a los parámetros. Con esto, además, puede verlo.
- **La auditoría del método** puede preguntar si los parámetros del modelo final salen de un instrumento suyo o se
  escribieron a mano.

## 8. Calibrar sus propios instrumentos

Un instrumento suyo puede tener errores: un optimizador que no converge, una métrica mal calculada. Es el mismo problema
que el de los instrumentos del entorno (SPEC-CALIBRACION-INSTRUMENTOS), del lado del investigador:
- **La pauta de método** le dice que pruebe un instrumento con datos donde conoce la respuesta antes de fiarse de él. Por
  ejemplo, ajustar su propio modelo sobre puntos que ese mismo modelo generó.
- **El senior lo revisa** como revisa su modelo.
- **No hay contrato del entorno:** es su herramienta, y la responsabilidad es suya.

## 9. Cómo se le cuenta

Una sección del prompt del asistido, `YOUR OWN INSTRUMENTS`, que dice:
- que puede escribir y registrar instrumentos;
- qué API le da este entorno, y sus límites;
- que un instrumento analiza lo observado y no observa nada nuevo;
- que lo que mida con ellos sigue sujeto a los checks.

Sin ejemplos del entorno: ni "ajusta tus parámetros así" ni ningún instrumento de muestra. Es guía de método permitida.

## 10. Medidas y evaluación

- **Medidas para el operador:**
  - instrumentos registrados y sus versiones;
  - usos;
  - si los parámetros del modelo final aparecen en el resultado de algún uso;
  - el R² del check por ronda, antes y después de empezar a usarlos.
- **Evaluación:** runs emparejados de `c302closed`, con y sin instrumentos propios, con la misma versión, varias semillas
  y el mismo presupuesto. Lo esperado: que el error del check deje de oscilar sin tendencia.
  - Si aun con parámetros bien ajustados el modelo no se sostiene, el problema está en su forma, no en sus números. Ese
    diagnóstico hoy no se puede hacer.

## 11. Plan

1. **Sandbox y API mínima** en los mundos de leyes: `register_instrument`, `use`, `env.episodes`, `points`, `came`,
   `answer` y `random`; topes; registro en el diario y repetición determinista.
2. **La sección del prompt** y la memoria (clase `instruments`).
3. **El resumen del senior y el finding.**
4. **La cuadrícula,** con su API de partidas y posiciones.
5. **Un piloto** en `c302closed`, emparejado con un run sin instrumentos.

Se activa con `review_from` (SPEC-INVESTIGADOR-ASISTIDO §14.6), así que los runs anteriores se repiten sin cambios.

## 12. Preguntas abiertas

- ¿Puede un instrumento usar otro instrumento suyo (`env.use`)? Haría sus herramientas componibles, pero complica los
  topes y la repetición.
- ¿Deben poder compartirse instrumentos entre runs, con `--experience` o en un equipo? Hoy la experiencia transfiere
  hallazgos, no herramientas.
- ¿Hace falta un tope de instrumentos por run, o basta con que cada uso gaste un paso?

## 13. Implementado (13/10/2026)

**Diferencias con la propuesta:**
- **Registrar** es un campo de cualquier respuesta, como los documentos, y no una petición:
  `"instruments": [{"do": "write" | "forget", "id", "about", "source"}]`. No gasta pasos.
- **Usar** sí es una petición de investigación (gasta un paso):
  `{"use": "<id>" | "<id>@<versión>", "args": {...}, "answers": [{"model": <ronda>, "on": [...], "every": n}]}`.
- **El código corre síncrono** en la VM. Así el tope de tiempo lo impone la propia VM, sin depender de que el código
  ceda el control. Evaluar los modelos del investigador es asíncrono en el arnés, así que se pide en el uso (`"answers"`)
  y se calcula antes de ejecutar el instrumento. El instrumento lo lee con `env.answers(<ronda>, "<ref>", every)`, que
  sustituye a `env.answer` de §5.
- **Sin Jev:** al responder un modelo, sus reglas para el Juez cuentan 0,5. No se rechaza un modelo con reglas
  decorativas.

**Lo que hay:**
- **`learn/assisted/instruments.ts`:**
  - `Instruments` registra, versiona, olvida y usa instrumentos;
  - `parseInstruments`;
  - `instrumentsSection`, la sección del prompt;
  - topes: código de 12.000 caracteres, resultado de 20.000 (recortado y avisado), 3.000 puntos por uso entre lecturas y
    respuestas, y 30 s;
  - sandbox sin `Date`, sin `Math.random` ni generación de código desde cadenas; `env.random(seed)`;
  - el instrumento lee copias, nunca los objetos del arnés.
- **API (`env`):**
  - `episodes()`;
  - `points("<ep>" | "<ep>@<a>-<b>", every)`, cada punto con `{ point, p, came }`;
  - `series("<ep>")`, cuando el laboratorio la declara (`lab.series`, `lab.seriesDoc`). c302closed la declara: tiempos,
    corrientes y señales por paso, alineados con su percepto;
  - `answers(...)`;
  - `random(seed)`.
  
  Lee los episodios del investigador y los de sus checks, nunca los de validación ni los ciegos.
- **El runner** (`lab-runner.ts`) lo activa para el asistido desde `review_from`:
  - sección del prompt;
  - registro en cualquier respuesta (`law-session.ts`);
  - uso por el canal del asistido (`assisted/session.ts`);
  - índice `your_instruments` en su cuaderno.
- **Diario:**
  - eventos `instrument_registered` (con el código), `instrument_used` (argumentos, resultado o error, tiempo) e
    `instrument_forgotten`;
  - al repetir un run, los usos se vuelven a ejecutar sobre los mismos datos.
- **Memoria:** clase `instruments` (ids `instrument:<id>@<versión>`) cuando hay alguno, también en el lector de diarios
  del senior y de la experiencia.
- **Senior:**
  - su resumen muestra por ronda `instruments_registered` (con el principio del código) e `instruments_used` (argumentos y
    resultado);
  - su prompt incluye la sección de instrumentos tal como la recibe el junior.
- **Finding:** `assistance.instruments` (id, versiones, usos, fallidos).
- **Pruebas** (`test/instruments.test.ts`):
  - su propio ajuste por mínimos cuadrados sobre sus puntos;
  - versiones y determinismo;
  - lo que no tiene (reloj, azar sin semilla, el proceso);
  - respuestas pedidas y no pedidas;
  - topes de tiempo, puntos y tamaño;
  - copias;
  - un run completo con registro, uso, cuaderno, finding, resumen del senior y memoria.

**Pendiente:**
- el piloto emparejado en c302closed (paso 5);
- las preguntas abiertas de §12.

## 14. La cuadrícula (13/10/2026)

En la cuadrícula los episodios son partidas, y no hay una señal por punto que predecir: el modelo da un valor a cada
posición, y lo que el entorno responde es cómo acaba cada partida.
- **`env.episodes()`:** sus partidas (id, lugar, ronda, quién eligió sus pasos, puntuación, pasos). Nunca las de una
  validación; las de la confirmación a ciegas no se guardan.
- **`env.points("g3" | "g3@<a>-<b>", every)`:** cada punto con la imagen que reciben sus observaciones (`p`: `picture`,
  `cells`, `width`, `height`, `you`, `next`, `step`) y lo que salió (`came`: `{ episode_score, steps_to_its_end }`).
- **`env.answers(<ronda>, ref, every)`:** el valor que su fórmula de esa ronda dio a esos puntos, calculado con su código de
  salida y sus reglas en 0,5. Una fórmula sin código de salida sólo responde a través del Juez, así que se rechaza.
- **El resto, como en los mundos de leyes:** registro en cualquier respuesta, uso como petición, sandbox, topes,
  diario, índice en el cuaderno, memoria, resumen del senior (`juniorInstruments` le da la sección de la cuadrícula) y
  finding. Desde `review_from`.
- **La sección del prompt** es la común, con las palabras de la cuadrícula para puntos y respuestas
  (`GRID_INSTRUMENT_WORDS`). La de los mundos de leyes no cambia.
- **Prueba** (`test/instruments.test.ts`): un run asistido de la cuadrícula registra un instrumento y lo usa sobre `g1`, con
  la imagen, el final de la partida y el valor que dio su modelo en cada punto.

## 15. Lo que cuesta leer un episodio (14/10/2026)

**El problema.** En c302closed, el percepto `p` de cada punto lleva la historia entera hasta ese paso. `env.points`
copiaba cada punto, así que leer todos los puntos de un episodio de 4.000 pasos eran unos 24 millones de números. El tope
de 3.000 puntos por uso contaba puntos, no tamaño. El autor pidió resolverlo en el entorno y en la estructura de datos, sin
decirle al investigador cuál es la forma eficiente.

**La estructura:**
- **En cada uso, cada episodio se copia una sola vez** (sus series), la primera vez que el instrumento lo lee.
  `env.series` devuelve esa copia, y `env.points` construye sobre ella el percepto de cada punto
  (`lab.perceptAt(series, k, prefix)`).
- **Los arrays de historia de `p` son vistas del prefijo de la copia** (`prefixView`), no copias. Se comportan como arrays
  normales: longitud, índices, métodos, `Array.isArray`, iteración y JSON. No se pueden escribir.
- **El instrumento ve exactamente el percepto de sus observaciones,** y leer todos los puntos de un episodio cuesta el
  episodio, no su cuadrado.
- **El tope** pasa a contar los números copiados de las series (`INSTRUMENT_NUMBERS_MAX`, 5 millones por uso), cada
  episodio una vez. Los mundos sin series (la cuadrícula, cuyos puntos tienen tamaño fijo) siguen copiando cada punto,
  con el tope de puntos. Lo mismo vale para las respuestas de sus modelos.
- **La sección del prompt no cambia:** nada le indica al investigador qué primitiva usar.

**Prueba** (`test/instruments.test.ts`):
- las vistas se comportan como arrays y no se pueden escribir;
- en c302closed, el percepto y lo que salió, construidos sobre las series, son idénticos a los de los puntos de los checks
  (pasos 0, 1, 7, 1.234 y 3.999);
- un instrumento que recorre los 4.000 puntos de un episodio ve en cada uno su historia entera, y tarda lo que cuesta el
  episodio.

## 16. El piloto emparejado (14/10/2026)

- **`--no-instruments`:** la condición sin instrumentos. No hay sección del prompt, ni registro ni uso, y el senior no
  recibe la sección. La configuración lo guarda (`instruments: false`). Funciona en los mundos de leyes y en la
  cuadrícula.
- **`lib/examples/batch.c302closed-instruments-pilot.json`:** dos runs de la faceta de señales, idénticos salvo
  `--no-instruments` (semilla 1, 16 rondas, 5 millones de tokens, `--own-tests 2`, senior). Qué se compara y cómo
  lanzarlo: `batch.c302closed-instruments-pilot.md`.
- **Prueba:** un run con `--no-instruments` no tiene sección, ni registros, ni usos.

## 17. Revisión externa (14/10/2026): qué cambió

- **El sandbox no deja salir (P1).** Al `env` se le pasaban funciones del anfitrión, y desde una de ellas se llegaba a
  `process`, `Date` y `Math.random` (`env.episodes.constructor("return process")()`); también desde los argumentos.
  - **Ahora sólo cruzan cadenas y números.** El `env` se construye dentro del sandbox (`BOOTSTRAP`) y habla con el arnés
    por un único puente que sólo recibe y devuelve JSON, nunca lanza excepciones hacia dentro y no está al alcance del
    código del investigador.
  - **Los argumentos y el resultado** se convierten a texto y desde texto dentro del sandbox.
  - **El percepto de c302closed** se construye dentro del sandbox, con el código que declara el laboratorio
    (`perceptAtSource`) y vistas del prefijo definidas también dentro.
  - **El mismo agujero estaba en las observaciones de código** de todos los mundos (`nodeVmRunner`), porque el percepto
    era un objeto del anfitrión. Ahora el punto entra como JSON y se lee dentro. Una consecuencia: el código recibe una
    copia, así que escribir en ella ya no es un error, y no afecta a nada. El modo antiguo con funciones del mundo en el
    contexto (`ctx.world.actions`), que sólo usaban unas pruebas, queda para el runner de funciones.
- **Un resultado no puede bloquear el run (P1).** Convertirlo a JSON se hacía fuera del límite de tiempo: un `toJSON`
  infinito colgaba el proceso, y devolver una función provocaba una excepción sin controlar. Ahora la conversión ocurre
  dentro del sandbox y del límite, y un resultado que no se puede escribir en JSON es un error del instrumento.
- **La reanudación de runs anteriores (P1).** Los instrumentos se activaban con `review_from`, que ya existía antes que
  ellos: un diario con `review_from: 0` hecho antes recibía su sección desde la ronda 1, y su repetición divergía.
  - **Ahora cada capacidad añadida después tiene su propio inicio** en el diario (`capabilities_from`, y en el código
    `CAPABILITIES` y `capabilityAt`). Un diario hecho antes la recibe sólo en sus rondas nuevas al continuarlo, y nunca al
    reanudarlo tal cual.
  - **Un diario sin `capabilities_from` la tenía** si su configuración lo dice (la opción `instruments`) o si se hizo con
    un código que ya la traía (`git merge-base --is-ancestor` con el commit que la introdujo).
- **Pruebas** (`test/instruments.test.ts`, `test/node-vm.test.ts`, `test/observer.test.ts`):
  - los cuatro caminos de salida, cerrados: `env`, argumentos, datos y errores;
  - un `toJSON` infinito, cortado por el límite;
  - devolver una función, como error;
  - el percepto construido dentro, idéntico al de los checks;
  - un diario con `review_from: 0` hecho sin instrumentos: se reanuda sin divergir y, al continuarlo, los recibe en
    sus rondas nuevas;
  - una observación no puede salir del sandbox por su punto.
