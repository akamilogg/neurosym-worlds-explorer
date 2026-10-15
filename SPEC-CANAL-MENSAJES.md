# SPEC · El canal de mensajes: un único mecanismo para todo lo que llega a System 2 entre sus respuestas

Estado: propuesta (15/10/2026). Sin implementar.

## 1. De dónde sale

Cada vez que hacía falta que el investigador supiera algo más, se añadía al arnés un mecanismo propio:
- **Los mensajes del operador y del senior** (`operator_messages`): los nuevos, en la pregunta con que llegan; los
  anteriores, repetidos detrás de la primera parte de cada ronda.
- **La tarea del operador** (`operator_task`) y los orígenes de las fuentes (`sources`), dentro de la primera parte.
- **Lo que cambia de sus instrucciones** (`instructions_added` / `instructions_now`, SPEC-INVESTIGADOR-ASISTIDO §14.10).
- **Su presupuesto** (`rounds_left`, `help_left`, §15), como contadores.
- **Las directivas abiertas de su senior** (SPEC-ORQUESTADOR §3.3.3).

Y faltaba otro: en el piloto del mundo de artefactos, el investigador no sabía, en las rondas en que no proponía versión,
cuál tenía aceptada. Revalidó la misma.

**El autor** (15/10/2026): no más trabajo para el arnés con cada dato. Debe haber **un canal de mensajes**:
- Cualquiera publica en él: el operador, el orquestador, el arnés con el presupuesto, el mundo… y el propio System 2.
- Lo publicado le llega antes de su siguiente pregunta.
- **System 2 también puede pedir que algo le llegue siempre.** Por ejemplo, un `tasks.md` suyo: así se monta su propio
  planificador sin depender de acordarse de abrirlo.

Es un mecanismo del arnés, sí, pero uno solo y general. Los que hay pasan a ser publicadores.

## 2. Principios

- **Un solo camino.** Todo lo que llega a System 2 entre sus respuestas, y que no es la respuesta a lo que pidió, llega
  por el canal.
- **El arnés publica y entrega; no interpreta.** No decide qué es importante ni resume. Cada publicador dice lo suyo.
- **La conversación sólo crece** (§14.10). Lo que entrega el canal va en un mensaje añadido. Nunca va en el prompt de
  sistema ni reescribe una parte anterior.
- **Reproducible.** Cada entrega queda en el diario con su pregunta. Un run reanudado entrega lo mismo en la misma
  pregunta.
- **Lo que llega es dato, no orden.** Un mensaje del mundo o del operador no se convierte en instrucción del arnés.
  Qué hacer con él lo decide System 2, y rinde cuentas de las directivas como siempre (§3.3.3).
- **Sin métrica para System 2.** El canal no abre una puerta para ella: el mundo publica hechos (una versión aceptada),
  nunca cuánto.

## 3. El mensaje

```json
{ "id": "m12", "from": "operator" | "agent:<id>" | "harness" | "world" | "self",
  "kind": "notice" | "pinned", "key": "<for a pinned one: what it is>", "body": { ... } | "<text>" }
```

**Dos clases:**
- **Aviso (`notice`).** Se entrega una vez, en la siguiente pregunta. Queda en la conversación de esa ronda, en el
  diario y en su memoria (§13), pero no se repite. Por ejemplo:
  - "versión v3 aceptada, ronda 5" (el mundo);
  - un mensaje del operador;
  - "el foco cambió" (el arnés).
- **Fijado (`pinned`).** Se envía en cada ronda con su valor de ese momento. Tiene una clave: publicar otra vez con la
  misma clave sustituye el valor, y retirarlo lo quita. Por ejemplo:
  - el presupuesto (`harness:budget`);
  - la tarea del operador (`operator:task`);
  - una directiva abierta (`agent:senior:directive:<id>`, retirada cuando la rinde);
  - un documento suyo (`self:document:tasks`).

  El valor de un fijado puede ser vivo: el de un documento es su última versión cuando se entrega.

## 4. La entrega

**Al abrir cada ronda,** justo detrás de su primera parte (el contexto de la ronda), una parte del canal con:
- **`pinned`:** todos los fijados, cada uno con su clave, su autor y su valor actual;
- **`notices`:** los avisos publicados desde la última entrega.

**Dentro de la ronda,** antes de cada pregunta, sólo si hay algo nuevo, otra parte añadida al final con:
- los avisos nuevos;
- los fijados cuyo valor cambió desde la última vez que se le dieron en esa ronda.

Lo que no cambió no se repite dentro de la ronda: ya está más arriba en la conversación.

**La pregunta de un solo mensaje** (la reflexión) lleva la parte del canal dentro.

**El diario** registra:
- cada publicación (`channel_published`: id, autor, clase, clave);
- cada entrega (`channel_delivered`: pregunta, ronda, los avisos y las claves con la versión de su valor).

**Al reanudar:**
- **lo publicado por el arnés y el mundo sale igual,** porque sus valores se derivan del run;
- **lo del operador y los agentes llega por su bandeja,** sin control del tiempo. Se entrega en la pregunta registrada,
  como hoy (`deliveredMessages`), y lo nuevo, cuando la repetición acaba.

## 5. Quién publica, y qué

| Autor | Avisos | Fijados |
|---|---|---|
| **Operador** (bandeja `inbox.jsonl`) | sus mensajes | su tarea (`--task`, o la que cambie un foco) |
| **Agente senior** | sus mensajes | sus directivas abiertas, hasta que el junior las rinde |
| **Arnés** | un cambio de foco, unas fuentes permitidas, unas instrucciones añadidas | el presupuesto (rondas y ayuda), los orígenes de las fuentes |
| **Mundo** | sus hechos de aceptación: una versión del artefacto aceptada | — de momento ninguno |
| **System 2** (`self`) | — | lo que él fije |

**El mundo** publica por una interfaz única (`LabContext.publish`), sin tocar el arnés. El de artefactos publica la
aceptación de una versión. Otro mundo publicará lo suyo, siempre hechos y nunca análisis.

## 6. Lo que fija System 2

En cualquier respuesta:

```json
"pins": [ { "do": "pin", "id": "tasks", "document": "tasks" },
          { "do": "pin", "id": "accepted", "message": "m12" },
          { "do": "pin", "id": "reminder", "text": "check the duplicates family before validating" },
          { "do": "unpin", "id": "reminder" } ]
```

- **Qué puede fijar:**
  - un documento suyo (§14.1): llega su última versión;
  - un aviso que recibió, para tenerlo presente;
  - un texto corto.
- **Así se monta su planificador:** escribe `tasks` con lo pendiente, lo fija, y cada ronda lo tiene delante. Al
  actualizarlo, la ronda siguiente llega la versión nueva.
- **Sin topes** (el autor, 15/10/2026). Qué fija y cuánto ocupa es decisión suya, como el resto de su presupuesto: lo que
  fija se repite cada ronda y le cuesta en cada pregunta. El operador lo mide (§10).
- **Ve lo que tiene fijado:** en la parte del canal de cada ronda, con sus ids.
- **Lo que fijan otros no puede quitarlo.** La tarea del operador o una directiva abierta no son suyas.

## 7. Lo que deja de existir

Con el canal, los mecanismos actuales pasan a ser publicaciones:
- `operator_messages` (nuevos y anteriores) → avisos del operador o del agente. Los anteriores ya no se repiten cada
  ronda: están en su historia y en su memoria, y si quiere tener alguno presente, lo fija.
- `operator_task` y `sources.origins` en la primera parte → fijados.
- `instructions_added` / `instructions_now` → avisos del arnés. Las instrucciones vigentes, además, fijadas
  (`harness:instructions`), porque no pueden perderse entre rondas.
- `rounds_left` / `help_left` → el fijado `harness:budget`.
- Las directivas abiertas → fijados del senior.

**No pasa por el canal:**
- el prompt de sistema;
- la primera parte de la ronda (su cuaderno, su modelo, su último check);
- lo que pidió y su respuesta (pasos de investigación, actos, rechazos);
- los contadores de la ronda (`steps_left`, `acts_left`), que son parte de esa respuesta.

## 8. Condiciones y diarios anteriores

- **La capacidad `channel`,** con su inicio en `capabilities_from`. Un diario hecho antes se reanuda con los mecanismos
  de entonces.
- **El investigador de mundo desconocido** sigue congelado: no recibe el canal. Sólo `stop`, que no es un mensaje.
- **Interruptores para comparar:**
  - `--no-pins`: System 2 no puede fijar;
  - `--budget-hidden` deja de publicar el presupuesto, como ahora.

## 9. El senior

**Primero el junior.** Después, el senior como segundo destinatario del mismo canal:
- le llegan los avisos del run (aceptaciones del mundo, respuestas del junior a sus directivas);
- puede fijar sus propios documentos.

Su conversación ya sólo crece (`test/append-only.test.ts`): la parte del canal se añade igual.

## 10. Medidas y evaluación

Son del operador:
- **Qué fija System 2 y cuánto tiempo:** qué documentos, cuántas versiones mientras estaban fijados, cuándo los quitó.
- **Si un documento fijado se mantiene:** cuántas rondas pasan entre sus versiones, y si lo que dice como pendiente
  coincide con lo que hace después (lo juzga Jev en la auditoría de método, no una regla).
- **El coste:** caracteres por ronda de la parte del canal, y la fracción de la pregunta que ocupan los fijados.
- **Comparación** con y sin `--no-pins`, en el mismo mundo, semilla y modelo: si fijar su plan cambia el método.

## 11. Riesgos y preguntas abiertas

- **Crecimiento.** Los fijados se repiten cada ronda y no hay topes: la pregunta puede crecer. Es un coste que gestiona
  él, y que se mide (§10). Si un run lo muestra como problema, se vuelve a mirar con datos.
- **Fijar todo.** Si fija todo, nada destaca. Elegir qué tener delante es parte de su método, y la auditoría lo juzga.
- **Mensajes del mundo como canal encubierto.** Un mundo podría colar análisis en sus avisos. La regla es la de siempre
  (sin investigación precocinada): sólo hechos de sus veredictos. Se revisa en el código de cada mundo.
- **Orden.** Dentro de una entrega: primero los fijados, por autor (operador, agentes, arnés, mundo, self), y luego los
  avisos por orden de publicación. Es fijo para que la repetición sea exacta.
- **¿Avisos con caducidad?** Hoy no. Un aviso se entrega una vez y basta.

## 12. Plan

1. **El canal y la entrega** en los mundos de leyes: publicación, avisos y fijados, la parte del canal en cada ronda y
   en cada pregunta con novedades, y el diario. Pruebas:
   - cada aviso se entrega una vez;
   - un fijado llega en cada ronda con su valor del momento y no se repite dentro de la ronda si no cambia;
   - la conversación sólo crece;
   - un run reanudado entrega lo mismo en las mismas preguntas.
2. **Los `pins` de System 2** y el documento fijado vivo.
3. **El mundo publica:** `LabContext.publish`, y el de artefactos, la aceptación de cada versión. El finding guarda la
   cadena de versiones aceptadas, y la última es el producto.
4. **Migrar lo que hay** (§7): presupuesto, tarea, fuentes, instrucciones, mensajes del operador y directivas. Cada uno
   con su prueba antigua adaptada.
5. **La cuadrícula,** a la par.
6. **El senior** como segundo destinatario.
7. **Un piloto en artefactos** con "lo más rápido que puedas con tu presupuesto", con y sin `--no-pins`.

## 13. Implementado

### 13.1 Paso 1: el canal y su entrega (15/10/2026)

**El canal** (`lib/src/learn/assisted/channel.ts`, `Channel`):
- `publish(from, {kind, key?, body?, unpin?})`: un aviso recibe un id; un fijado, su clave (`<autor>:<key>`).
- **El valor de un fijado puede ser una función:** se lee al entregarlo, así un documento llega en su última versión.
- `deliver({round, question, opening})`:
  - en una apertura, todos los fijados y los avisos pendientes;
  - después, sólo lo nuevo: avisos, fijados cuyo valor cambió y los retirados (`unpinned`);
  - si no hay nada, ninguna parte.
- **El orden es fijo:** por autor (operador, agentes, arnés, mundo, self) y luego por clave.
- **El diario registra** `channel_published` y `channel_delivered` (ronda, pregunta, ids de los avisos y claves de los
  fijados).

**La entrega en los mundos de leyes** (`LawSessionHost.channel`): antes de cada pregunta, lo que trae el canal se añade
como parte nueva.
- La primera pregunta de una conversación es apertura: la de cada ronda, y la que sigue a una consolidación.
- Una ronda abre así: su primera parte (el contexto) y, justo detrás, la del canal.

**El canal se explica a sí mismo.** Cada parte de apertura lleva `about`, con lo que es el canal; el prompt de sistema
no tiene nada de él.
- **Por qué:** un run en el que nadie publica pregunta exactamente lo que preguntaba antes, y nada del prompt fijo cambia
  por el canal.
- **El coste** es una frase al abrir cada ronda en que hay algo que entregar.

**El mundo publica** por `LabContext.publish`, como autor `world`. Sólo existe para el investigador asistido de un run
que empieza con la capacidad `channel`. El de mundo desconocido no tiene canal.

**Pruebas** (`test/channel.test.ts`):
- **La clase:** un aviso una vez, el fijado en cada apertura, nada si nada cambió, el valor vivo leído al entregarse, la
  retirada, el orden y el diario.
- **Un run con un mundo que publica** (cada episodio que extrae, un aviso; cuántos lleva, fijado):
  - cada aviso llega una vez en todo el run;
  - el fijado llega justo detrás de la primera parte de cada ronda, con `about`;
  - la conversación sólo crece;
  - un run cortado y reanudado entrega lo mismo en las mismas preguntas.
- **El investigador de mundo desconocido** no recibe nada.

### 13.2 Paso 2: lo que fija System 2 (15/10/2026)

- **En cualquier respuesta,** `"pins"` (`parsePins`): fijar un documento suyo, un aviso que recibió o un texto (uno de
  los tres), o retirar por id. Lo que no se puede leer es un aviso en su respuesta, nunca una suposición.
- **El runner lo publica como `self`:**
  - **un documento** es un valor vivo: llega su última versión (`{document, version, text}`) o que ya no existe;
  - **un aviso** sólo si ya le llegó;
  - **un texto** tal cual.

  Fijar otra vez el mismo id lo sustituye. Lo que fijaron otros no lo puede quitar: sus claves son de otro autor.
- **Se le confirma** en `your_pins`, y los rechazos van entre los avisos de su respuesta.
- **El prompt de sistema lleva una línea** (`PINS_SECTION`) desde la primera pregunta: es una herramienta suya y tiene que
  saber que existe. Dice qué puede fijar, no qué fijar.
- **`--no-pins`** es la condición sin fijados: ni la línea ni lo que intente fijar (`config.pins`).
- **Pruebas** (`test/channel.test.ts`). Un run en el que:
  - escribe su lista de tareas y la fija junto con un texto;
  - la reescribe a mitad de la ronda 2, y en la pregunta siguiente le llega la versión 2;
  - la ronda 3 abre con la versión 2 y sin el texto, que retiró;
  - un aviso que nunca recibió se rechaza con su razón.

  Además, la conversación sólo crece, y un run cortado y reanudado no diverge. `--no-pins` no tiene ni la línea ni los
  fijados.

### 13.3 Paso 3: el mundo publica, y la cadena de versiones (15/10/2026)

- **Cada versión aceptada.** En un mundo con artefacto, cada versión que el protocolo del artefacto acepta se registra
  (`artifact_accepted`) y se publica en el canal como aviso del mundo: `{"artifact_accepted": {"version", "round"}}`.
  - Llega al investigador al abrir la ronda siguiente.
  - Una versión ya aceptada no se registra dos veces.
- **No hay listón que suba.** Cada versión se juzga contra la referencia. Que una sea más rápida que otra lo mide el
  investigador con sus ejecuciones; el entorno sólo dice si se sostiene.
- **El fin del run y el finding** guardan la cadena (`artifact.chain`): todas las versiones aceptadas, en orden. La última
  es el producto (`artifact.version`).
- **La interfaz del mundo de artefactos** lo dice: cada versión se juzga contra la referencia, puede aceptarse más de una
  y la última aceptada es su producto.
- **Pruebas** (`test/channel.test.ts`), con un mundo de prueba con artefacto: dos versiones aceptadas en las rondas 1 y 2.
  - El aviso de cada una abre la ronda siguiente, con autor `world`.
  - El finding da la segunda como producto y la cadena completa.

### 13.4 Paso 4: lo que había pasa por el canal (15/10/2026)

**Quién entrega.** El canal lo entrega ahora el cliente del junior (`operatorClient`), no la sesión.
- Ese cliente ya era por donde pasaba todo lo del operador. Recibe el canal (`OperatorChannel.messages`) y deja de
  colocar nada por su cuenta.
- La sesión de los mundos de leyes ya no tiene gancho propio (`LawSessionHost.channel`, del paso 1, se retira).
- La cuadrícula, que pregunta por el mismo cliente, lo tendrá con sólo darle un canal (paso 5).

**Qué se publica:**

| Antes | Ahora |
|---|---|
| `operator_messages.new` | un aviso del operador o del agente (su mensaje tal cual) |
| `operator_messages.earlier`, repetidos cada ronda | nada: están en su historia y su memoria; si quiere uno presente, lo fija |
| una directiva | fijada por su agente (`agent:<id>:directive:<id>`) hasta que la rinde; entonces se retira |
| `operator_task` en la primera parte | fijado `operator:task` (y retirado si deja de haber tarea) |
| `sources.origins` en la primera parte | fijado `harness:sources` |
| `instructions_added` / `instructions_now` | fijado `harness:instructions`: lo añadido, o el prompt entero tras un foco |
| `rounds_left` / `help_left` entre los contadores | fijado `harness:budget`, leído al entregarse |

**Sin cambios:** los contadores de la ronda (`steps_left`, `acts_left`, `memory_answers_left`) siguen en las partes de
la conversación, y el diario sigue registrando `operator_message` con su pregunta (para la reanudación y para contar la
ayuda).

**El canal es del investigador asistido desde que ayuda.** En una continuación que pasa del investigador de mundo
desconocido al asistido:
- el canal se abre en el relevo, y el presupuesto se fija entonces;
- hasta ese momento no se publica ni se entrega nada.

Así, el historial que se repite es el que vivió el otro investigador.

**Los diarios hechos antes** (sin la capacidad `channel`) siguen por el camino de antes, que se conserva tal cual.

**Pruebas.** Las que leían las formas antiguas leen ahora el canal. `test/support.ts` junta las partes del canal en
`user.channel` y da dos ayudantes:
- `heardOf`: los avisos del operador y de los agentes, y las directivas fijadas;
- `taskOf`: la tarea fijada.

Se adaptaron `assisted`, `focus`, `append-only`, `budget`, `channel`, `orchestra-directives`, `orchestra-senior`,
`orchestra-project` y `sources`. Las pruebas de continuación (`continuation`, `review`) encontraron el fallo del relevo,
ya corregido.

### 13.5 Paso 5: la cuadrícula, y los mensajes fijados de otros (15/10/2026)

**La cuadrícula** tiene el canal (`LabServices.channel`) en un run del investigador asistido que empieza con la
capacidad.
- Su cliente, el mismo que el de los mundos de leyes, lo entrega.
- La cuadrícula publica su presupuesto fijado (`harness:budget`, y deja de ponerlo entre los contadores) y los `pins` de
  su investigador, con la misma función (`applyPins`, compartida con los mundos de leyes).
- Su prompt lleva `PINS_SECTION` salvo con `--no-pins`.

**Un mensaje puede pedir ir fijado.** Una orden de mensaje admite `pin: "<clave>"`: se publica fijado bajo esa clave, en
lugar de como aviso, y llega en cada ronda.
- **De dónde sale:** el papel de cada miembro de un equipo (SPEC-INVESTIGACION-PARALELA) se mandaba como mensaje al
  empezar. Antes se repetía en cada ronda porque se repetían los mensajes anteriores; con el canal, un aviso llega una
  vez y el papel se perdía en la segunda ronda.
- **Ahora el equipo lo fija** (`pin: "role"`), porque un papel es una asignación permanente, no un aviso.

**Pruebas:**
- `test/channel.test.ts`: en la cuadrícula, el presupuesto fijado desde la primera ronda, lo que fija su investigador en
  cada ronda siguiente, y la conversación que sólo crece.
- `test/parallel.test.ts`: cada miembro reconoce su papel en todas las rondas.

### 13.6 Paso 6: el senior, segundo destinatario (15/10/2026)

**El senior tiene su propio canal.** Vive mientras corre su proceso y se entrega antes de cada pregunta suya, como parte
añadida a su conversación, que sigue sólo creciendo.
- **Al abrirse su conversación,** o al consolidarla o reiniciarla, recibe todo lo fijado otra vez.
- **Lo entrega primero en cada vuelta:** si se le pide consolidar, ese aviso es lo último que lee.

**Lo que le llega:**
- **Los avisos del mundo al junior** (una versión del artefacto aceptada…), leídos del diario: cada uno una vez.
  - Para eso el diario guarda el cuerpo de los avisos del mundo y del arnés.
  - Los mensajes del operador y de los agentes ya están en el diario como `operator_message`.
- **El presupuesto del junior,** fijado (`harness:junior_budget`) y calculado de su diario:
  - las rondas que le quedan;
  - con presupuesto de ayuda, la ayuda que le queda.

  Así una recomendación sabe cuánto queda.
- **Lo que fija él mismo,** con `"pins"`, como el junior: una nota de su cuaderno (llega en su último texto), un aviso
  que recibió o un texto.
  - Lo fijado queda en su estado (`pins`): en un run reanudado se vuelve a fijar.

**Su prompt** (`SENIOR_ROLE`) lleva una línea que dice qué es su canal y cómo fijar.

**Pruebas:**
- `test/orchestra-senior-memory.test.ts`:
  - el aviso del mundo al junior le llega una vez;
  - el presupuesto del junior, calculado de su diario;
  - la nota que fija le llega en su siguiente pregunta, y queda en su estado;
  - su conversación sólo crece.
- Las que contaban posiciones fijas en su conversación cuentan ahora la parte del canal.

**Siguiente:** paso 7, el piloto en artefactos ("lo más rápido que puedas con tu presupuesto"), con y sin `--no-pins`.

### 13.7 El canal del senior es un espejo del del junior (15/10/2026)

**El paso 6 se quedaba corto.** El canal del senior recibía piezas elegidas a mano: los avisos del mundo y el
presupuesto, y después la tarea. Nunca recibió la tarea del operador desde el principio. Su prompt es el brief del junior,
que no la lleva, y en un run de 3SUM dijo que bajar de O(n²) "no se pedía" hasta que el junior se lo contó.

**El principio:** dos mitades de un mismo investigador saben lo mismo del encargo.

**Por tanto:**
- **El diario registra cada entrega al junior entera** (`channel_delivered`: ronda, pregunta, si fue apertura, y
  `delivered` con lo fijado, lo retirado y los avisos).
- **El canal del senior refleja esas entregas tal cual** (`Channel.mirror`), además de lo que fija él. No hay selección:
  lo que el canal del junior entregue en el futuro llega también al senior.
- **Al reanudar un senior,** lo fijado se reconstruye sin repetir avisos.
- **Lo que deja de existir:** las publicaciones propias del senior del paso 6 (`harness:junior_budget`, los avisos del mundo
  leídos aparte y la tarea).
