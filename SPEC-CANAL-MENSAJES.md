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
