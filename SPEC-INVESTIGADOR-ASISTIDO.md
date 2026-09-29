# SPEC · Dos investigadores: el de mundo desconocido y el asistido

Estado (29/09/2026): **A1–A6 hechos**. El resto, propuesto.

Parte de lo que ya existe tras SPEC-OBJETIVO (O7–O14):

- el contrato `Lab` / `GameLab`;
- el runner común, con `runLaboratory` como biblioteca;
- la grabación y la reanudación con procedencia;
- el finding con dos vistas;
- el entorno externo con efectos una sola vez.

## 1. Motivación

Hasta ahora el proyecto ha estudiado una pregunta: si un sistema aprende un mundo **por su cuenta**, sólo con lo que el
mundo le responde. Para que sea usable como herramienta de investigación faltan tres cosas:

1. **Información externa.** Consultar documentación o recursos que dé el operador.
2. **Dirigir la tarea.** En un mundo con dinámicas complejas, no todas son el objetivo. El sistema debe poder aislar lo
   que interesa para una tarea dada.
3. **Colaboración en vivo.** Ver el trabajo en curso de cada investigación y poder mandar mensajes a los investigadores,
   por ejemplo para sacarlos de un mínimo local.

Las tres rompen, a propósito, la regla que define el experimento actual. Por eso no se añaden a él. Se construye **otro
investigador completo**, y los dos conviven.

## 2. Principios

- **P1. El investigador de mundo desconocido queda congelado.**
  - Su prompt, su sesión, sus instrumentos y lo que recibe System 2 no cambian con nada de este documento.
  - Un test lo fija byte a byte, por mundo.
- **P2. Dos implementaciones completas, no un interruptor dentro de una.**
  - El asistido tiene su propio paquete (`lib/src/learn/assisted/`): su sesión, su prompt y sus instrumentos.
  - Un cambio en el asistido no puede alterar lo que ve el puro.
- **P3. Lo que comparten es lo que no enseña nada a System 2:**
  - los mundos (`Lab`, `GameLab`) y sus familias;
  - el protocolo y el criterio;
  - la grabación y la reanudación;
  - el journal y el finding;
  - los servicios del runner.
- **P4. El criterio no cambia: decide el mundo.**
  - Ni una fuente, ni un mensaje, ni un foco hacen que un modelo se sostenga.
  - Se sostiene si lo que el mundo respondió lo dice, en los laboratorios, en la familia y a ciegas, como hoy.
- **P5. Toda aportación del operador deja rastro.**
  - Cada mensaje, cambio de foco y lectura de una fuente queda en el journal, entra en la grabación (una reanudación la
    reproduce en el mismo punto) y aparece en el finding.
  - Un resultado conseguido con ayuda nunca se presenta como descubrimiento propio.
- **P6. Los runs de un investigador no se comparan con los del otro** como si fueran la misma condición.
- **P7. Una sola API de control para los dos.** La consola visual y la línea de órdenes son dos caras de esa API.

## 3. Los dos investigadores

| | *unknown-world* (el actual) | *assisted* (nuevo) |
|---|---|---|
| Aprende de | lo que el mundo responde | el mundo, y además mensajes y foco del operador, y fuentes que lee por su cuenta donde el operador permite |
| Sesión, prompt, instrumentos | los de hoy, congelados | propios: `list`, `open`, `find` (con `select`), `task`, `operator_messages` |
| Control del operador | parar, reanudar, cancelar | lo mismo, más enviar mensajes, cambiar el foco y permitir orígenes de fuentes |
| Journal | `researcher: "unknown-world"` | `researcher: "assisted"` y cada aportación como evento |
| Finding | como hoy | añade `assistance`: qué ayuda hubo, y de dónde viene cada afirmación |
| Mundos | todos (`Lab` y `GameLab`) | primero los `Lab` (leyes); la cuadrícula, después (§9) |

### 3.1 Elegir investigador

- **Parámetro:**
  - `--researcher unknown-world|assisted`, o `researcher` en `runLaboratory`.
  - Por defecto, `unknown-world`.
- **Política del operador:**
  - Se declara en la línea de órdenes, en la consola o en `runLaboratory`, con la forma
    `{ allow: [...], force?: 'unknown-world'|'assisted' }`.
  - Un agente que lanza una investigación elige a su criterio dentro de lo permitido.
  - Si el operador fuerza uno, se usa ese.
  - Si el agente pide uno prohibido, el run no empieza (`LabError`).
- **Journal:** guarda qué se pidió, qué se usó y con qué política (`researcher`, `researcher_requested`,
  `researcher_policy`).

## 4. La API de control común

Es una capa sobre `runLaboratory` que sirve igual a los dos investigadores. Está en `lib/src/runtime/control.ts`, y la CLI y
la consola la usan.

### 4.1 Un run como objeto con estado

Un run se identifica por su journal (`runs/<nombre>-<hora>.json`). Junto a él, además de los ficheros de hoy (grabación y
findings):

| Fichero | Qué es | Quién escribe |
|---|---|---|
| `<run>.status.json` | estado vivo: `running` / `stopping` / `ended`, pid, último latido, ronda, investigador, coste | el runner, en cada evento |
| `<run>.inbox.jsonl` | órdenes del operador, una por línea, con id y hora | la CLI y la consola; nunca el runner |

- **Estado derivado:**
  - Un journal con evento `end` está terminado.
  - Uno sin `end` y con latido reciente está en curso.
  - Uno sin `end` y con el latido parado, está interrumpido y se puede reanudar.
- **Órdenes:** `stop`, `message`, `focus` y `source`. El runner lee el buzón antes de cada pregunta a System 2, en el mismo
  punto donde hoy mira la cancelación y los presupuestos.
  - `stop` vale para los dos investigadores. Es control, no información para System 2.
  - `message`, `focus` y `source` sólo las acepta el asistido. El puro las **rechaza y lo registra**
    (`operator_command_refused`), para que conste que se intentó y que no le llegó.
- **Acuse:** cada orden recibe un evento con su id (`operator_command`, aceptada o rechazada). La CLI y la consola lo
  muestran.

### 4.2 Funciones

```ts
startRun(lab, { researcher, args, policy, ... }) -> { run, journal }   // lanza un proceso aparte y devuelve en seguida
listRuns(root) -> [{ run, lab, researcher, state, round, cost, stoppedBy? }]
runStatus(run) -> estado vivo + últimos eventos
watch(run, onEvent) -> deja de mirar                                    // sigue el journal en vivo
send(run, command) -> { id }                                            // escribe en el buzón
resumeRun(run, { budgets }) -> { run, journal }                         // run derivado, como hoy
finding(run, view) -> Finding                                           // vista de operador o de investigador
```

## 5. La línea de órdenes

`scripts/lab.ts`, sobre la API de §4:

```bash
lab start --lab cells --researcher assisted --seed 1 --level 3 [--policy force=unknown-world]
lab list
lab status <run>
lab watch <run>              # los eventos en vivo, legibles
lab send <run> "mira qué pasa en el paso 0"     # sólo asistido
lab focus <run> <faceta>                         # sólo asistido (§6.2)
lab source <run> <dir|url|dominio>               # sólo asistido (§6.3): permite un origen
lab stop <run>
lab resume <run> [--max-tokens N]
lab finding <run> [--view researcher]
```

- Las claves siguen viniendo sólo del entorno del proceso que lanza el run. Nunca pasan por la API, el buzón ni la consola.
- Los lanzadores actuales (`run-*.ps1`, `run-*.sh`) siguen funcionando igual.

## 6. El investigador asistido

Su sesión (`AssistedSession`) tiene la misma forma que `LawSession`: rondas, cuaderno, pasos de investigación, propuesta y
reflexión. Así el protocolo y el runner la usan igual. Su prompt es el común más una sección propia, y sólo él la ve.

### 6.1 Mensajes del operador

- **Recorrido:**
  1. Un `message` del buzón se entrega en la siguiente pregunta a System 2 como `operator_messages: [{ at, text }]`.
  2. Después pasa al cuaderno como nota del operador. System 2 puede citarla, seguirla o descartarla.
- **Registro:** evento `operator_message`.
- **Reanudación:** se graba en un canal `operator` junto con el número de la pregunta en que se entregó. Al reanudar, llega
  en el mismo punto; los mensajes nuevos, en vivo.
- **Límite opcional:** un presupuesto de mensajes por ronda, para que un operador no pueda convertir la investigación en un
  dictado.

### 6.2 Foco de la tarea

Hay dos niveles distintos.

**Foco estructural: facetas del laboratorio.**
- Un `Lab` puede declarar facetas: qué cantidad predecir, qué parte del sistema, qué régimen.
- `--focus <faceta>` cambia lo que el objetivo pide y comprueba: la forma de la respuesta, los casos y el veredicto. Las
  dinámicas fuera del foco no cuentan en el criterio; System 2 tiene que aprender a ignorarlas.
- Elegir faceta es **definir la tarea, no ayudar** (como `--level`). Se propone que la usen los dos investigadores al
  arrancar; ver la pregunta abierta 1.
- Cambiar de faceta durante el run es sólo del asistido. Reinicia la etapa del protocolo, como la escalada de la
  cuadrícula.
- **Mundo de prueba:** hace falta uno con dinámicas que sobren. Hay dos candidatos:
  - `orbit` con varios cuerpos móviles y foco en uno;
  - `cells` con dos capas, una de ellas irrelevante para la faceta.

**Enunciado del operador (sólo asistido).**
- Un texto breve de qué se quiere entender ("cuándo se vuelve inestable", "qué pasa si X"), mostrado como `task`.
- Es una pista y rompe la regla de cero pistas, por eso no existe en el puro.

### 6.3 Fuentes externas

Las fuentes las lee **el investigador, por su cuenta**. El operador sólo pone los límites; el arnés no carga, no trocea,
no indexa ni vigila nada por él.

- **Orígenes permitidos (lista blanca del operador):** `--sources-allow <a,b,...>` al arrancar, o la orden `source` durante
  el run. Un origen es un directorio o fichero (ruta absoluta; en la línea de órdenes, relativa a la raíz), un prefijo de
  URL o un dominio (con sus subdominios). Fuera de ellos no se lee nada.
- **Instrumentos del asistido** (en su investigación, como cualquier otro, y sólo cuando hay algún origen):
  - `{"list": "<directorio>"}`: los documentos de texto que contiene. Un origen web no se lista: sus documentos se nombran
    por su URL.
  - `{"open": "<documento>", "from": n, "to": n}`: esas líneas, numeradas (hasta 200), cuántas tiene y un hash de lo leído.
    Se lee de nuevo cada vez: volver a abrir es como el investigador contrasta una fuente, por ejemplo cuando contradice al
    mundo o a otra fuente. Si ha cambiado, lo juzga él.
  - `{"find": "palabras", "in": "<documento|directorio>"}`: las líneas que contienen todas las palabras, como un grep.
    Muestra 40 y dice cuántas hay.
  - `"select": "lo que necesito"` en un `find`: de las líneas encontradas, **Jev** escoge las que hablan de ello. Es un
    `find` inteligente que System 2 activa cuando quiere, típicamente cuando salen demasiadas líneas. Jev ve sólo la
    necesidad y las líneas, nunca el mundo, y se le pregunta de qué hablan, no si son ciertas. Sin Juez (`--flat`) no está
    disponible y se dice.
  - Más adelante: búsqueda en la web por su cuenta, limitada a los dominios de la lista blanca.
- **Sus notas:** lo que aprende de cada fuente lo guarda en su cuaderno, como el resto.
- **Evidencia con origen:** una creencia cita lo leído junto a puntos del mundo
  (`evidence: ["ep3@4", "src:<documento>#L12-30"]`).
- **Las fuentes proponen, el mundo decide (P4).** El criterio no las lee.
- **Referencias, no verdades.** Una fuente o una cita es una aproximación de lo que su autor pudo ver con sus instrumentos:
  una referencia cuestionable, nunca una verdad absoluta. El investigador la trata como a sus propias creencias: la
  contrasta con sus instrumentos, la vuelve a leer cuando hace falta y la **refuta** cuando no encaja con el mundo que
  observa, y anota en su cuaderno qué tomó de cada fuente y qué refutó y por qué. Así conserva el escepticismo y la
  autorreflexión que ya ha mostrado con sus propias hipótesis.

## 7. Journal, grabación y finding

- **Journal:**
  - arriba: `researcher`, `researcher_requested`, `researcher_policy`;
  - eventos nuevos: `operator_command`, `operator_command_refused`, `operator_message`, `focus_changed` y
    `sources_allowed` (un origen permitido durante el run, con su pregunta);
  - en el asistido, `list`, `open` y `find` quedan en la investigación como cualquier instrumento;
  - `source_select`: lo que Jev puntuó en un `select`. Es del operador; System 2 recibe sólo las líneas escogidas.
- **Grabación:**
  - Canales nuevos: `operator` (mensajes, cambios de foco y orígenes, con el número de pregunta) y `source` (cada lectura,
    local o web, con el host en la identidad). Una reanudación recibe lo que se leyó antes del corte y después lee en vivo.
  - `stop` no se graba, porque es control.
  - Una reanudación sin la grabación sigue siendo un error (§12 de SPEC-OBJETIVO).
- **Finding:**
  - `researcher` en las dos vistas.
  - En el asistido, además, `assistance`:
    - mensajes (cuántos y cuáles);
    - cambios de foco;
    - fuentes: los orígenes permitidos, lo que abrió y lo que buscó;
    - por cada afirmación, `grounded` (`world`, `operator`, `sources`), según su evidencia.
  - La vista del investigador **conserva `assistance`**: es procedencia, no información privada del operador.

## 8. La consola visual

`scripts/lab-console.ts` es un servidor local, escuchando sólo en `127.0.0.1`, que sirve una página. Usa la API de §4 y
reutiliza el visor de journals (`src/view/`).

- **Lista de runs:** lab, investigador (con una marca clara), estado, ronda, coste y motivo de parada.
- **Run en curso:** se actualiza en vivo siguiendo el journal y muestra:
  - el camino de rondas;
  - el modelo actual y sus comprobaciones por lugar;
  - el cuaderno (creencias, notas);
  - las últimas peticiones de investigación;
  - el coste y los presupuestos.
- **Run terminado:** la síntesis visual actual y los dos findings.
- **Controles:**
  - lanzar un run (lab, investigador, argumentos, política), parar, reanudar;
  - en un run asistido, además: caja de mensajes, selector de faceta y orígenes de fuentes permitidos.
  - En un run puro, los controles de colaboración aparecen **desactivados, con el motivo**.
- **Claves:** las pone el entorno del proceso de la consola; nunca viajan por la página.

## 9. Plan

Cada fase deja intactos los journals del investigador puro. Lo comprueban el LLM falso y los journals de referencia, como
en O9–O14.

| Fase | Contenido | Criterio de éxito |
|---|---|---|
| A1 | API de control y registro de runs: estado y latido, buzón con `stop`, rechazo registrado de las órdenes de colaboración en el puro, `researcher` y política en `runLaboratory` y en el journal | journals puros idénticos salvo los campos nuevos; `stop` por buzón para un run en otro proceso; test de prompt puro byte a byte por mundo. **Hecho**: `runtime/control.ts` (`listRuns`, `runStatus`, `send`, `stop`, `orderOutcome`, `finding`, `watch`, `startRun`, `resumeRun`); estado y latido cada 2 s; `researcher`, `researcher_requested` y `researcher_policy` en el journal y `researcher` en el finding; `assisted` todavía da `LabError` (A4) |
| A2 | CLI `lab` | un run lanzado, seguido, parado, reanudado y consultado sólo con la CLI, sin tocar ficheros a mano. **Hecho**: `scripts/lab.ts` sobre `runtime/cli.ts` (`labCli`, testeable); un run se nombra por su ruta, su nombre, un prefijo o `last`; `send`, `focus`, `source` y `stop` esperan el acuse del run y dicen si se aceptó o por qué se rechazó; `watch` sigue hasta el final o hasta que el latido se para |
| A3 | Consola visual | la misma secuencia desde la página, con runs de los dos investigadores a la vez. **Hecho**: `scripts/lab-console.ts` sobre `runtime/console.ts` (API JSON y una página, sólo en 127.0.0.1, y rechaza otro `Host`); lista de runs con la marca del investigador y su estado; detalle en vivo (eventos, modelo actual, última comprobación, creencias, coste, finding en las dos vistas, enlace a la síntesis visual); parar, reanudar y lanzar; el panel de colaboración aparece para todo run y, en el puro, desactivado con el motivo. Probado también a mano en el navegador. Con A4, runs de los dos investigadores a la vez, y la colaboración con el asistido (probado a mano) |
| A4 | Investigador asistido, esqueleto y mensajes: `AssistedSession`, su prompt, `operator_messages`, canal `operator` en la grabación, `assistance` en el finding | un mensaje llega en la pregunta siguiente y queda en el journal; un run asistido cortado y reanudado recibe cada mensaje en el mismo punto; el puro sigue idéntico. **Hecho**, por composición y sin tocar la sesión compartida: `learn/assisted/session.ts` da a `LawSession` su propio prompt (el común más `ASSISTED_SECTION`) y un cliente de System 2 que añade `operator_messages: { new, earlier }` a la pregunta siguiente; una pregunta sin mensajes es, byte a byte, la del puro. Cada entrega queda como `operator_message` con su número de pregunta; al reanudar se reinyecta en la misma pregunta desde el journal reanudado, así que la grabación reconoce cada petición (el journal hace de canal `operator`: es la misma información). `focus` y `source` se rechazan con el motivo (A5, A6); la cuadrícula asistida da `LabError` (A7). En el finding, `assistance` y, por afirmación, `grounded` (`world`, `operator`, `sources`). Probado también desde la consola, con runs de los dos investigadores a la vez |
| A5 | Foco: facetas en el contrato `Lab`, un mundo con dinámicas que sobran, `--focus`, cambio de faceta en vivo y `task` en el asistido | con la faceta, las dinámicas fuera de foco no cuentan en el criterio; un run acepta un modelo que sólo explica la faceta. **Hecho**: `Lab.facets` (id y ayuda), `interface({ focus })` y `focus()` en el anfitrión del objetivo. Mundo de prueba: `cells` nivel 4, dos capas en una fila (las celdas pares y las impares, cada una un anillo con su regla elemental); facetas `all`, `even` y `odd`; con faceta, la interfaz añade una línea que dice qué posiciones cuentan y el objetivo compara sólo esas (sin faceta, el prompt no cambia: hashes congelados intactos). `--focus` lo aceptan los dos investigadores al arrancar (define la tarea) y queda en el journal y en la pregunta del finding; una faceta que el laboratorio no tiene es `LabError`. `--task` sólo el asistido (`LabError` en el puro) y va con cada pregunta como `operator_task`. Un `focus` en vivo (CLI `lab focus <run> <faceta> [tarea]`, consola) se valida contra las facetas, llega como mensaje en la pregunta siguiente y se aplica entonces: el prompt dice lo que cuenta, el protocolo reinicia la etapa y queda `focus_changed`; al reanudar se aplica en la misma pregunta y la grabación reconoce cada petición. Journals puros idénticos a la línea base (0 diferencias en los cuatro mundos) |
| A6 | Fuentes: orígenes permitidos por el operador, `list`, `open` y `find` (con `select` por Jev) del investigador, citas `src:`, `grounded` en el finding, lecturas por la grabación | una creencia cita una fuente; el finding separa lo comprobado en el mundo de lo que sólo viene de las fuentes; una fuente engañosa no hace sostenerse a un modelo falso. **Hecho** (§6.3), tras descartar un primer diseño en el que el arnés cargaba, troceaba, indexaba y vigilaba una biblioteca: ahora el arnés sólo hace cumplir la lista blanca (`Sources.permitted`: dentro de un directorio permitido, sin escapar por `..` ni enlaces; bajo un prefijo de URL; en un dominio o sus subdominios), graba cada lectura (canal `source`, también las locales, así que un run reanudado recibe lo que se leyó antes del corte aunque el fichero haya cambiado) y da la procedencia en el finding. `--sources-allow` y la orden `source` sólo en el asistido (`LabError` y rechazo registrado en el puro; un origen inexistente se rechaza). Los instrumentos entran en la sesión compartida por un gancho inerte (`extraRequest`, ausente en el puro) y los responde el asistido, nunca el mundo; con algún origen, el prompt añade `SOURCES_SECTION` y cada pregunta lleva `sources.origins`. Journals puros idénticos a la línea base (0 diferencias en los cuatro mundos) |
| A7 (opcional) | La cuadrícula asistida (`GameLab`) | la cuadrícula acepta mensajes y fuentes con su bucle propio |

**Orden:** A1–A3 dan valor a los dos investigadores desde ya (ver y controlar) y son la base para observar A4–A6. Después
va A4, porque los mensajes son lo más directo de la colaboración. Luego A5 y A6.

## 10. Evidencia que la sostendría

- **Coste:**
  - Con el mismo mundo y la misma seed, ¿cuánto baja el coste hasta la aceptación con mensajes del operador en los
    atascos?
  - ¿Y con una fuente fiel?
- **Robustez frente a fuentes engañosas:** una fuente que describe mal el mundo no debe producir aceptaciones (P4). ¿Cuánto
  cuesta a System 2 descartarla?
- **Aislamiento:** en un mundo con dinámicas que sobran, ¿el asistido con `task` aísla antes la faceta que el puro sólo con
  la faceta?
- **Comparaciones legítimas:** siempre dentro del mismo investigador, o como condición declarada (P6).

## 11. Preguntas abiertas

1. **¿Facetas en el puro?** Recomendado sí, fijadas al arrancar. Definen la tarea (qué se pide), no ayudan a resolverla,
   igual que `--level`. El cambio de faceta en vivo, sólo en el asistido.
2. **¿Un agente puede hacer de operador?** Por ejemplo, un coordinador que manda mensajes a los investigadores que lanzó.
   Propuesta: sí, en el asistido, identificado como autor de cada orden en el journal (`by`). La política decide qué agentes
   pueden enviar qué órdenes.
3. **Presupuesto de ayuda:** ¿límite de mensajes por ronda o por run? Propuesta: configurable, sin límite por defecto,
   siempre visible en el finding.
4. **¿Pausa distinta de parar?** Propuesta: no. Parar y reanudar ya es una pausa, con procedencia completa (run derivado).
5. **¿La consola lanza runs con claves?** Propuesta: sólo las del entorno del proceso de la consola. Si hacen falta varias
   cuentas, perfiles con nombre definidos fuera de la página.
