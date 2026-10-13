# SPEC · Instrumentos propios: el investigador escribe las herramientas con que analiza sus datos

Estado: propuesta (13/10/2026), sin implementar.

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
