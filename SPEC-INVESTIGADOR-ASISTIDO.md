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
  - Congelado frente a este documento, no para siempre. Un cambio del método común se hace a propósito, para los dos
    investigadores a la vez, y renueva los hashes. Los runs anteriores siguen siendo de su versión, que el journal
    identifica por el commit.
  - Cambios deliberados:
    - 01/10/2026: en PRACTICE, el equilibrio entre la teoría (visión estratégica, hipótesis generales) y pasos pequeños
      (pocas afirmaciones por ronda, el modelo como experimento, proponer sin miedo a equivocarse, no repetir lo que ya
      se tiene).
      - Motivo: Qwen3.8-27B sin razonamiento se pasaba del presupuesto de investigación, repetía peticiones y no
        proponía.
    - 01/10/2026: en EVIDENCE, comprometerse con hipótesis antes de creerlas del todo.
      - Una creencia es una apuesta de trabajo, y una refutada también es conocimiento.
      - Se puede llegar a la respuesta por descarte; fallar pronto y aprender es mejor que esperar a la hipótesis
        correcta entera.
      - Lo que el entorno respondió directamente es un hecho: se anota como creencia, y la duda se reserva para lo que
        se infiere de los hechos.
      - Motivo: Luna (run `grid-s22-2026-10-01T16-06-05-482Z`) hizo un barrido de cinco `act` y no anotó qué
        direcciones se aceptaban («they do not establish the movement rule»). Además mantuvo como mera pista que el
        borde derecho pierde, que es la regla verdadera.
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

### 3.2 Traspasar un run al asistido

El puro es la **referencia purista**: explora las capacidades de un System 2 con un método genérico y unas herramientas
mínimas para actuar y observar. Rara vez será la forma práctica de usar los investigadores en una aplicación real (autor,
30/09/2026). Cuando un run puro se atasca en un mínimo local, el operador puede **traspasarlo** al asistido para darle un
empujón, como el antiguo `operator_directive` del harness de Fox & Hounds.

- Sólo en una **continuación**: `--resume <journal> --attempts N --researcher assisted`. Sólo del puro al asistido, nunca
  al revés, y nunca sin rondas nuevas.
- Su historia se repite tal como la vivió el puro, **con el prompt del puro**, incluido su final (reflexión y
  calificación).
- Desde su primera ronda nueva es el asistido: su sección del operador, y los mensajes, el foco y las fuentes. Un
  mensaje enviado mientras se repite la historia espera a esa ronda.
- El journal lleva `assisted_after_attempts` y el evento `researcher_switched`, y el finding lo recoge en
  `assistance.assisted_after_attempts`: lo conseguido después nunca se presenta como del puro (P5, P6).

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
| A7 (opcional) | La cuadrícula asistida (`GameLab`) | la cuadrícula acepta mensajes y fuentes con su bucle propio. **Parcial**: mensajes y memoria selectiva (§13.1); tarea, foco y fuentes, no |

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
   pueden enviar qué órdenes. Desarrollado en `SPEC-ORQUESTADOR.md` (agente operador, orquestador y planificador).
3. **Presupuesto de ayuda:** ¿límite de mensajes por ronda o por run? Propuesta: configurable, sin límite por defecto,
   siempre visible en el finding.
4. **¿Pausa distinta de parar?** Propuesta: no. Parar y reanudar ya es una pausa, con procedencia completa (run derivado).
5. **¿La consola lanza runs con claves?** Propuesta: sólo las del entorno del proceso de la consola. Si hacen falta varias
   cuentas, perfiles con nombre definidos fuera de la página.

## 12. Idea futura: memoria de exploraciones (30/09/2026)

Explorar mundos deja journals con **métodos y técnicas de exploración** que pueden transferirse de un mundo a otro:

- los métodos que System 2 escribe en su cuaderno («replicate_launch», «compare_terminal_columns»...);
- sus lecciones y reflexiones;
- los experimentos que funcionaron y los que le hicieron perder rondas.

Es un tipo de aprendizaje y de generalización: no del mundo, sino de **cómo investigar**. La idea es que un investigador
pueda consultar apuntes de exploraciones pasadas, propias o de otros, en busca de inspiración o de experiencia.

Cómo encajaría con lo que ya existe:

- **Como una fuente más** del asistido (§6.3): un origen permitido por el operador, leído con `list`, `open` y `find`.
  Los apuntes son referencias cuestionables, no verdades: lo que funcionó en un mundo puede no servir en otro.
- **Sólo la vista del investigador** (O14): métodos, lecciones, reflexiones, creencias y el finding de esa vista. Nunca
  `hidden_from_the_learner`, la verdad ni las medidas del operador, o la verdad de un mundo se filtraría a otro run del
  mismo mundo.
- **Procedencia:** lo que tome de un apunte lo cita (`exp:<run>#<método o ronda>`), y el finding lo separa como ahora
  separa `world`, `operator` y `sources`.
- **El puro no la tiene.** Su referencia es aprender sólo de lo que el mundo responde. Sería una condición declarada del
  asistido: «con memoria de exploraciones».
- **Preguntas que abre:**
  - ¿La experiencia de un mundo acorta la investigación en otro, en coste y en rondas?
  - ¿Transfiere el método o arrastra sesgos? Por ejemplo, traer el encuadre de series temporales a un mundo donde no
    sirve.
  - ¿Apuntes propios frente a los de otros investigadores o modelos?
  - ¿Cómo se destila un journal largo en apuntes útiles, y quién lo hace: el propio investigador al terminar, o un agente
    del orquestador (SPEC-ORQUESTADOR)?

## 13. Idea futura: memoria selectiva sobre el propio journal (01/10/2026)

**De dónde sale.** En el run de Qwen3.8-27B sin razonamiento (`grid-s22-2026-10-01T11-13-04-850Z`), el investigador
experimenta en las rondas 1–5 (`act`, `replay`, contraejemplos) y a partir de la 6 sólo relee partidas (`view` = 56 de
81 peticiones). Los datos del contexto:

- el contexto de una llamada va de 4,4k a 45,7k tokens; el de inicio de ronda crece de unos 8k a 22k;
- dentro de una ronda crece con lo que devuelve cada investigación (partidas enteras vistas);
- el cuaderno al final ocupa unos 57k caracteres (creencias 20k, notas 14k, rondas 14k, partidas 9k) y viaja entero
  en cada llamada.

Un modelo pequeño arrastra todo y pierde el hilo; uno grande (Sol) lo aguanta mejor.

**La idea.** Una herramienta como `view` o `act`, pero que opera sobre **su propio journal** en vez de sobre el mundo:
el investigador decide qué recuperar de lo que ya sabe, en lugar de recibirlo todo. Mismas primitivas que las fuentes
(§6.3), aplicadas a otro origen:

- `list`: el índice. Ids y títulos de creencias, notas, métodos, partidas y rondas, con su estado y ronda. Los títulos
  los escribe el propio investigador; el entorno no resume nada.
- `open`: un elemento entero (una creencia con su historia, una nota, el resultado de una prueba, una partida).
- `find`: filtro literal por texto, id, partida o posición (`g66@6`).
- `select` (opcional, a discreción de System 2): Jev ordena los resultados de un `find` frente a la hipótesis que el
  investigador escribe, igual que en las fuentes.

**Lo que la hace útil: la contrapartida.** Sólo ahorra contexto si el contexto por defecto adelgaza: índice +
creencias activas + la última ronda, y lo demás a petición. Lo que entra por defecto debe ser una regla mecánica y
declarada (nada elegido por el entorno). Además, el investigador puede archivar sus notas: dejan de viajar en cada
llamada pero siguen recuperables. Así sigue siendo System 2 quien gestiona su cuaderno.

**Cómo encaja con los principios:**

- Fuentes propias. Sólo su journal en la vista del investigador, nunca `hidden_from_the_learner` ni medidas del
  operador.
- Sin investigación precocinada. Son primitivas de lectura. `select` con Jev es un instrumento que System 2 activa,
  como en `find` de las fuentes.
- El puro no la tiene (prompt congelado). Sería una condición declarada del asistido: «con memoria selectiva».
- Es el mismo instrumento que la memoria de exploraciones (§12), con otro origen: `self` frente a journals de otros
  runs. Conviene diseñarlos juntos.

**Riesgo principal: sesgo de confirmación.** Filtrar por relevancia frente a la hipótesis en curso tiende a traer lo
que la apoya y a dejar fuera los contraejemplos, justo lo que en este run le hizo cambiar de idea (g33@7 frente a
g32@8). Mitigaciones:

- `select` devuelve también lo que contradice la hipótesis, en un apartado aparte;
- `find` literal está siempre disponible;
- el journal registra qué se pidió, qué se devolvió y qué se descartó, para que el operador lo audite.

**Cómo se evaluaría.** Qwen sin razonamiento, grid seed 22, con y sin la herramienta, varias réplicas. Se medirían:

- tokens de contexto por llamada;
- uso de herramientas por ronda (¿vuelve a experimentar en las rondas tardías?);
- creencias que se sostienen frente a las que se reescriben;
- victorias por intento y reglas recuperadas;
- con y sin `select`, para aislar a Jev.

### 13.1 Implementación (01/10/2026, sólo la cuadrícula)

- `lib/src/learn/assisted/memory.ts`: `JournalMemory` sobre el cuaderno, más lo que el investigador pidió y recibió en
  cada paso (`investigation:r<n>.<k>`) y los veredictos de cada prueba (`check:r<n>`).
  - Peticiones `{"memory": "list" | "open" | "find", ...}`; `select` con Jev (`judgeSelector`, el mismo de las fuentes).
  - Jev puntúa de qué trata cada elemento, no si da la razón: un contraejemplo sobre el mismo tema también sale.
  - Cada selección queda en el journal (`memory_select`: lo que vio, lo que puntuó y lo que se quedó), para auditarla.
- Regla fija de lo que viaja por defecto (`brief`), declarada en `MEMORY_SECTION`:
  - creencias con su última postura;
  - notas de las dos últimas rondas enteras, las anteriores por sus primeras palabras, las archivadas no;
  - métodos enteros;
  - episodios de las dos últimas rondas;
  - una línea por modelo y el último entero;
  - la última reflexión.
- La investigación de la ronda en curso viaja entera, como en el puro. Una primera versión la recortaba (sólo los dos
  últimos pasos enteros). En el run con Qwen eso le ocultó lo que acababa de ver: volvió a pedir las mismas partidas sin
  pasos y abrió su memoria para recuperarlas, y la ronda 1 acabó sin propuesta. Las investigaciones de rondas
  anteriores, que el puro tampoco arrastra, sí quedan en la memoria.
- Notas: `{"do": "archive", "id"}` deja de mostrar una nota cada ronda; volver a escribirla la recupera.
- Una respuesta con sólo peticiones de memoria no gasta `steps_left`; `memory_answers_left` dice cuántas le quedan en la
  ronda (4).
  - Sin pasos, una respuesta que mezcla memoria y mundo responde sólo la memoria y se lo avisa, en vez de rechazarla
    entera.
  - Una petición de memoria escrita fuera de `investigate` se ejecuta como tal, con aviso.
  - Las dos medidas evitan que tres rechazos en una ronda terminen el run.
- Insistir sin pasos: el asistido de la cuadrícula puede pedir investigar con `steps_left: 0` hasta 3 veces por ronda
  sin que cuente como rechazo.
  - Cada vez se le recuerda que proponga, y queda en el journal (`investigation_refused`, con lo que pidió).
  - El puro, igual que siempre: esas respuestas siguen siendo rechazos y no se registran.
  - Motivo: Qwen se pasa del presupuesto a menudo (9 veces en 10 rondas del run sin memoria). En el run
    `grid-s22-2026-10-01T14-53-39-218Z` lo hizo tres veces seguidas en la ronda 2, que acabó sin propuesta, y el run
    terminó tras un solo intento.
- Investigador asistido de la cuadrícula (A7, parcial): acepta mensajes del operador (`operatorClient`) y la memoria.
  - Tarea, foco y fuentes siguen sin construir para la cuadrícula.
  - Se lanza con `--researcher assisted --memory selective`, que sólo existe para el asistido y, de momento, sólo para la
    cuadrícula.
- El puro no cambia: hashes congelados y prueba de equivalencia sin diferencias.
- El finding lo recoge en `assistance.memory`: qué listó, qué abrió, qué buscó y cuántas selecciones hizo Jev.
