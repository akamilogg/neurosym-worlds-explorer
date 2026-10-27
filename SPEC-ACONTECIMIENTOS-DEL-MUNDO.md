# SPEC · Mundo vivo: actores, acontecimientos e investigación reactiva

Estado (27/10/2026): **H1, H2 y H3 implementados (§18); H4–H5 pendientes**. Diseño consolidado el 23/10/2026.
Revisión conciliada: puente con el investigador asistido, autoridad de actuación, hitos e integración K1–K5.
Sustituye la versión anterior limitada a acontecimientos dentro de episodios. Los contratos son normativos;
los nombres de interfaces y operaciones designan capacidades que se deben implementar, no APIs ya existentes.

Integra [canal](SPEC-CANAL-MENSAJES.md), [instrumentos](SPEC-INSTRUMENTOS-PROPIOS.md),
[calibración](SPEC-CALIBRACION-INSTRUMENTOS.md), [delegación](SPEC-DELEGACION-INVESTIGACIONES.md),
[investigación paralela](SPEC-INVESTIGACION-PARALELA.md) y [consola](SPEC-CONSOLA-INVESTIGACION.md).
En sesiones `living-world@1`, esta SPEC define ejecución compartida, permisos y comunicación. Los contratos
anteriores permanecen para runs episódicos; sus adaptadores no adquieren persistencia automáticamente.

## 1. La idea y el alcance

**Un mundo existe y evoluciona durante la investigación. Varios actores pueden observarlo, modificarlo y comunicarse.
Ocurren acontecimientos que un investigador no solicitó; puede percibirlos, ignorarlos o investigarlos.**

La novedad puede proceder de la dinámica, del azar, de otro actor o de una perturbación programada por el operador.
No necesita surgir primero como hipótesis del investigador. Una contaminación deja una zona sin crecimiento;
el mundo no anuncia «un hongo mató la bacteria». Explicar y contrastar la causa sigue siendo investigación.

El investigador conserva cuadernos, artefactos, instrumentos, backtracking y delegación. No se impone un archivo de
diversidad, una lista de hipótesis ni una obligación de cambiar de rumbo. El arnés amplía la experiencia disponible.

El alcance completo incluye estado persistente compartido, actores concurrentes y adaptativos, comunicación directa
y global, sensores propios, investigadores reactivos, acontecimientos programados o disparados por estancamiento,
servicios externos, evaluación, presupuestos, consola, cancelación, reanudación y reproducción del conjunto.
No se posponen los mundos compartidos ni la comunicación a una extensión futura.

## 2. Entidades y responsabilidades

| Entidad | Responsabilidad |
|---|---|
| Sesión | Identidad, manifiesto, reloj, miembros, permisos, límites y registro del mundo |
| Adaptador de mundo vivo | Estado, leyes, acciones, transiciones, percepciones, instantáneas y evaluación |
| Coordinador | Ordenar intenciones, reservar recursos y entregar datos; no interpretar científicamente |
| Actor | Identidad, política, acceso, objetivo y presupuesto propios |
| Investigador | Actor con las herramientas y registros de investigación existentes |
| Senior | Rol estratégico del mismo investigador, con su misma vista autorizada |
| Instrumento | Medición versionada, eventualmente vigilante sobre un flujo autorizado |
| Programa de acontecimientos | Agenda o disparador autorizado que solicita efectos tipados al mundo |
| Canal | Publicaciones y entregas con origen, destino y permisos |
| Evaluador | Realizaciones reservadas, aisladas de los actores exploratorios |

Junior y senior comparten identidad de actor y vista autorizada; mantienen decisiones y consumos separados por rol.
**Sólo el junior emite intenciones físicas en nombre de ese actor.** El senior conserva su función actual de lectura,
orientación y delegación autorizada; no llama `act` ni `wait` sobre el cuerpo del junior. Compartir identidad no le
concede un segundo turno. Hay como máximo un lote sellado por actor y ventana, siempre atribuible al junior.
Un senior que solicita una rama `shared` crea otro investigador con identidad y lote propios, no un segundo escritor
del lote del padre. Convertir un rol estratégico en actor físico exige un alta explícita de actor por el operador.
Otro investigador es otro actor. Un proceso físico no necesita conversaciones ni un LLM.
Investigar realizaciones distintas en paralelo e investigar un mismo estado son condiciones diferentes, declaradas.

## 3. Contrato del mundo vivo

Se añade `LivingWorldAdapter` junto al contrato episódico existente. No se simula persistencia concatenando episodios
reiniciados ni se cambia silenciosamente el significado actual de `World.step` o `Lab.act`.

Operaciones obligatorias:

- `create(config)`: estado inicial, reloj y actores.
- `validateIntent(state, actor, intent)`: permisos, precondiciones y reserva máxima de recursos.
- `advance(state, interval, intents, events)`: transición autoritativa y resultados con orden registrado.
- `observe(state, principal, query)`: proyección autorizada, no estado bruto por defecto.
- `snapshot/restore`: estado, actores, aleatoriedad, procesos y operaciones pendientes.
- `fork(snapshot, policy)`: realización aislada, cuando se declara esta capacidad; rechazo explícito en caso contrario.
- `evaluate(candidate, reservedConfig)`: ejecución reservada fuera del estado exploratorio.

El adaptador declara acciones, duraciones, perturbaciones, instrumentos, permisos, formatos de observación y garantías
de reproducción. Cada actor recibe sólo la parte autorizada del manifiesto. Código de instrumentos y programas se
ejecuta mediante el sandbox, con límites de tiempo, memoria y efectos; programable no significa acceso arbitrario al host.

Una consulta pura no muta el mundo. Una medición invasiva es una acción física. Las acciones largas conservan progreso
en el estado, mientras el mundo continúa. Cancelarlas tiene consecuencias declaradas, no un rollback ficticio.

## 4. Estado compartido y actores

Hay un único estado físico autoritativo por sesión. Lo que hace un actor puede alterar lo que otro observa. Cada uno
tiene proyección autorizada y memoria privada. Compartir mundo no concede acceso a cuadernos, objetivos privados,
políticas internas, credenciales, agendas ocultas ni evaluaciones reservadas.

Tipos admitidos: investigador, política fija, adversario reactivo, actor con LLM y población adaptativa o evolutiva.
Cada política recibe sólo su vista y sus mensajes. Puede reaccionar a acciones observables, pero no leer el cuaderno
o puntuación de otro. Sí puede conocer una hipótesis que su autor le comunique explícitamente.

Una población declara variación, selección, objetivos, semillas y tamaño máximo. Sus decisiones y estados quedan
registrados. No se impone un algoritmo evolutivo concreto a los demás actores.

El manifiesto fija altas, bajas, permisos físicos y de canal. Crear un actor requiere autorización y reserva dentro
del límite de población. Puede programarse su incorporación o retirada. Al retirarse deja de decidir; sus objetos
persisten o desaparecen según una transición declarada. No se elimina su historia.

## 5. Reloj, concurrencia y conflictos

### 5.1 Tiempo simulado, modo predeterminado

La sesión tiene reloj lógico, horizonte finito y cadencia de decisión `decision_interval`. Avanza aunque todos
esperen, hasta el siguiente acontecimiento, vencimiento de instrumento o ventana de decisión. No necesita que alguien
solicite otro episodio. Durante inferencias se congela el cómputo de la simulación: contestar antes no da ventaja física.

Cada ventana sigue este orden:

1. Integrar el intervalo anterior, acciones en curso y acontecimientos vencidos en orden temporal.
2. Confirmar estado y observaciones; evaluar sensores y disparadores sobre sus entradas autorizadas.
3. Encolar efectos disparados para una frontera futura; nunca reescribir el intervalo terminado.
4. Entregar mensajes vencidos y dar a los actores activos vistas de la misma revisión de estado.
5. Recoger intenciones, con inferencias concurrentes si procede; reservar recursos y sellar el lote.
6. Resolver conflictos, aplicar intenciones válidas y avanzar al siguiente intervalo.

Empates de acontecimientos: `(simulation_time, priority, event_id)`, con prioridad fijada en el manifiesto.
Conflictos de acciones: prioridad rotatoria por ventana sobre un orden de actores fijado por semilla. Cada intención
se revalida al aplicarse; una precondición rota produce conflicto, sin ejecutar sus efectos. Acciones compatibles se
integran conjuntamente. Un adaptador puede declarar y versionar una resolución simultánea específica en su lugar.

Las respuestas tardías no se aplican a otro estado. Cada ventana tiene límites de llamadas y tiempo de pared; un
timeout produce `no_op` y consumo conocido o incierto registrado. No se espera indefinidamente a un actor.
La independencia del ritmo del LLM rige cuando las decisiones llegan dentro de esos límites. Un timeout es una
excepción operativa que sí puede cambiar la trayectoria de una nueva ejecución; conservarlo permite replay, no
garantiza que otra ejecución en vivo alcance el mismo estado. Las comparaciones fijan límites iguales y holgados,
registran frecuencia y actores afectados y muestran resultados con/sin episodios afectados, sin borrar los fallos.
Leer memoria y desarrollar código consume recursos operativos, pero no tiempo físico simulado adicional. Las acciones
físicas se sellan para su ventana; las operaciones internas de investigación no avanzan el mundo por accidente.

`wait(duration)` suspende decisiones hasta vencer, salvo un despertar autorizado. Consume una acción al pedirse,
no una por tick. El avance autónomo consume recursos del mundo, no acciones ficticias de actores dormidos. Los saltos
temporales conservan todos los efectos y medidas; no omiten acontecimientos por optimización.

### 5.2 Tiempo real y servicios externos

`clock: realtime` declara que el mundo continúa durante inferencias y desconexiones. La latencia forma parte de esta
condición; no se atribuyen las garantías de equidad del modo simulado. El servicio es autoridad de reloj y efectos y
ofrece secuencias, IDs de operación y recuperación por cursor.

Sin idempotencia, una respuesta perdida deja el efecto incierto: se reconcilia, no se reenvía automáticamente. Una
laguna irrecuperable se registra y limita la reproducción. Si el servicio no admite pausa, detener al investigador no
pausa el mundo: al volver se recupera el flujo disponible y se identifican pérdidas.

### 5.3 Puente con las rondas del investigador actual

`living-world@1` integra **el investigador asistido** y conserva su bucle de investigación, propuesta, checks,
validación, reflexión y cierre de ronda. El investigador puro `unknown-world`, congelado, queda fuera de esta
integración y no se modifica. La sesión coordina el mundo; cada actor mantiene su run asistido, contador de rondas,
pasos, acciones, cuaderno y modelo. Una ventana del mundo no equivale a una ronda científica.

Una **llamada de decisión** es una petición al modelo y su respuesta, que puede contener varios pasos. Una **ventana**
puede contener varias llamadas de consulta por actor, acotadas por límites operativos; termina cuando los actores
activos ceden su lote o vencen sus límites. Una **ronda** puede atravesar varias ventanas y sólo termina por propuesta,
`close_round` o cierre operativo conforme al protocolo. Despertar no reinicia contadores ni crea una ronda gratuita.

| Operación del investigador | Efecto en la ventana y el reloj |
|---|---|
| `view`, `table`, memoria, experiencia, lectura de canales | Lee datos autorizados de la revisión o registros fijados; no avanza el mundo |
| `measure` o instrumento sobre datos ya obtenidos | Cálculo local, sin transición física |
| Medición invasiva o adquisición con duración | Intención física tipada, igual que `act` |
| Edición de cuadernos, artefactos o pruebas propias | Persiste el trabajo local; no avanza el mundo |
| `act` y `wait` | Sellan un lote para la ventana actual; su ejecución ocurre tras la barrera conjunta |
| Envío, `share`, alta/cambio de vigilante o rama compartida | Se prepara y confirma para la frontera; no se hace visible a otros en mitad de su decisión |
| Propuesta o `close_round` | Sella un lote físico vacío si no hay otro; cede la ventana y cierra la ronda científica |

Las consultas no consumen tiempo simulado, **pero no son gratuitas**: gastan pasos, inferencia y recursos habituales.
Una observación de estado actual fija su revisión. Los cálculos no acceden al estado futuro mientras se prepara el
lote. El manifiesto limita llamadas locales por ventana; alcanzar ese límite cede un lote vacío y conserva la ronda
en curso para la siguiente activación, sin reiniciar `steps_left` ni `acts_left`. Agotar el presupuesto de la ronda
utiliza el cierre/propuesta del protocolo existente; nunca fuerza nuevas acciones para continuar el reloj.

Una respuesta puede agrupar consultas previas y varias intenciones físicas independientes. La primera intención
inicia el lote: no se permiten consultas que pretendan leer sus resultados aún no ejecutados en esa misma respuesta,
ni combinar un lote físico con propuesta/cierre. Se valida el formato completo antes de producir efectos; un lote
mal formado se rechaza con motivo. Los `act` agrupados tienen orden declarado y no incorporan decisiones nuevas entre
ellos. Las acciones dependientes de un resultado se piden después de recibirlo, en otra ventana.

Cada actuación conserva ID y consume el cupo previsto; se devuelven aceptación, rechazo o conflicto por intención.
La aceptación inicial no inventa un episodio ya terminado. En la siguiente activación se añaden resultados
confirmados; operaciones largas entregan un recibo y luego su finalización. Sus trazas se exponen como episodios o
segmentos inmutables con `session`, intervalo y revisiones, compatibles con `view` y los instrumentos actuales.
Los avisos no solicitados usan el canal; las respuestas a acciones conservan su vínculo petición/respuesta.

### 5.4 Propuestas, Objective y validación

Una propuesta congela candidato y referencias en la revisión de su decisión. No es una acción física ni una
perturbación. Cede un lote vacío; la sesión completa su barrera ordinaria y ejecuta la evaluación reservada antes de
entregar el veredicto en una activación posterior. El tiempo de cómputo del check no añade tiempo físico en modo
simulado; en `realtime` el servicio continúa. En ambos casos la evaluación no modifica el estado compartido.

`evaluate(candidate, reservedConfig)` **no introduce un segundo juez de `holds`**. Es el adaptador de ejecución de
casos para `lib/src/learn/objective.ts` y `lib/src/learn/protocol.ts`: traduce realizaciones reservadas a casos con
lugar, propósito (`check`, `validation`, `blind`, `rerun`, `test`), contexto permitido, respuesta esperada o resultado
de actuación y hechos de comparación. `Objective` conserva forma de respuesta, comparación y criterio; el protocolo
conserva validación por familia, confirmación y regresión sobre los casos anteriores exigidos. `holds` requiere todas
las comprobaciones aplicables, no sólo nuevos casos. Los datos exclusivos del operador siguen separados.

Para objetivos de actuación el candidato es una política congelada que se ejecuta en realizaciones reservadas;
para predicción es el modelo que responde casos. Un resultado exploratorio observado no se convierte por sí solo en
aceptación. Si el adaptador no puede aportar casos compatibles con el Objective declarado, la configuración se
rechaza antes del run. No se sustituye por un veredicto libre del coordinador ni se acepta por consenso de actores.

## 6. Acontecimiento, percepción y atención

Un acontecimiento cambia el estado; una observación mide; atender es una decisión del actor. Puede haber sucesos sin
huella, con huella transitoria o descubiertos posteriormente. Un acontecimiento no genera automáticamente un aviso.
Una consulta posterior debe encontrar consecuencias coherentes, no texto aislado de la dinámica.

Una entidad introducida conserva identidad, tiempo de aparición y pertenencia a la vista. Antes de aparecer figura
como ausente, nunca con coordenadas inventadas. Los adaptadores declaran cómo representan entidades variables;
una tabla fija incompatible debe ampliarse o rechazar la operación.

El instrumento comunica medidas y calidad, no la causa oculta ni la relevancia científica. Si calcula una atribución
causal, se identifica como interpretación del instrumento, con versión y fundamento, no como verdad del mundo.
Cada observación conserva ID, instrumento y versión, sujeto, intervalo, unidades, calidad y referencia a datos
completos autorizados. Se distinguen tiempos de ocurrencia, medición y entrega.

## 7. Instrumentos vigilantes

Los instrumentos propios se reutilizan: `watch.register` fija versión inmutable, consulta o flujo autorizado, cadencia,
condición de aviso, destinatarios, vigencia y presupuesto. `watch.update` crea una versión; `watch.stop` cancela futuras
medidas. Un sensor preinstalado utiliza el mismo contrato. No obtienen acceso a datos que su propietario no puede leer.

Miden aunque su dueño no esté tomando decisiones. El aviso explica qué calcularon, sobre qué datos y cuándo. Las
reglas pueden ser código o fórmulas neurosimbólicas versionadas; toda inferencia se registra y contabiliza. El umbral
lo fija el instrumento, su autor o el manifiesto, no un criterio implícito de interés científico del arnés.

Se declaran frecuencia y límites de muestras, avisos, cómputo y almacenamiento. Agregación, enfriamiento y pérdidas
son explícitos. Fallar no devuelve una lectura normal. Los datos retenidos permiten calibración y revisión posteriores.

## 8. Mensajes individuales, directos y globales

Se extiende el canal existente con direccionamiento autenticado:

```json
{
  "id": "message:42",
  "session": "world:7",
  "from": "actor:researcher-a",
  "to": { "actor": "researcher-b" },
  "kind": "notice",
  "body": { "text": "Observé una desviación; comparto las medidas.", "refs": ["observation:17"] }
}
```

Destinos: `{actor: id}` o `{channel: "global"}`. Cada actor tiene bandeja individual con mensajes directos,
observaciones autorizadas y publicaciones globales. Global tiene historia propia: no contiene todos los privados.

`message.send`, `channel.read` y `channel.list` reutilizan herramientas y lectores del canal. El coordinador asigna
origen, identidad, tiempo y secuencia; no acepta suplantación mediante campos del mensaje. Enviar devuelve aceptación,
rechazo o pendiente. Aceptación no significa lectura ni acuerdo.

- Directos: legibles por emisor, destinatario y auditor autorizado. El senior recibe el espejo de su investigador.
- Global: una entrega por miembro autorizado activo al publicar. Nuevos miembros pueden consultar historia según
  permiso; no reciben toda la historia automáticamente como contexto.
- Referencias: no conceden permisos. `share` crea una copia o vista inmutable autorizada del material propio, con
  procedencia. No puede compartir material reservado al que no tiene acceso; referencias ilegibles se rechazan.
- Cada destinatario conserva cursor y recibo propios. Reanudar uno no repite entregas a los demás.
- Entrega entre decisiones, nunca reescribiendo contexto ni interrumpiendo una operación física atómica. Mensajes
  publicados durante una ventana se entregan como pronto en la siguiente.
- Fijados: sólo propietario u operador autorizado los modifica. Un actor puede fijar material en su bandeja; no
  imponer fijados en otra o en global sin permiso explícito.

Los actores pueden cooperar, negociar, discrepar o engañar según su política. Sus mensajes son testimonio; no modifican
automáticamente modelos, creencias o `holds`. Los avisos de instrumentos conservan su procedencia observacional;
el operador y senior conservan la de orientación. El texto recibido no concede herramientas o permisos.

Se declaran tamaño, frecuencia y coste de comunicación. Un exceso se rechaza, no se trunca silenciosamente. Las
bandejas conservan lo no incluido en contexto. Cada decisión tiene un límite de tokens de entrega, aviso de pendientes
y acceso por cursor al resto. Global contabiliza lecturas por receptor aunque el contenido se almacene una vez.

## 9. Investigador reactivo

Puede decidir periódicamente, por acontecimientos o con ambas modalidades. La política de activación declara
`on_observation`, `on_message`, `on_timer` y filtros sobre información autorizada. El operador fija límites; el
investigador configura vigilantes y suscripciones dentro de ellos.

Una observación elegible lo hace ejecutable en la próxima ventana, aunque no toque otra ronda periódica. No le obliga
a investigar: puede ignorar, consultar, esperar o actuar. Toda activación consume recursos operativos; no añade rondas
ni tokens gratis. Se agrupan avisos por ventana, con máximo de una activación por actor y ventana, enfriamiento y límite
total. No hay bucles instantáneos de mensajes e inferencias sin avance de reloj ni coste.

El senior comparte lo entregado al junior y puede tener activación reactiva declarada aparte. No se despierta
implícitamente por toda anomalía. Un aviso no se convierte automáticamente en señal de estancamiento.

Se distinguen dos mecanismos: el investigador reacciona a percepciones; el entorno puede reaccionar al estancamiento
según §10. Se registran por separado y ninguno requiere al otro.

## 10. Acontecimientos programables por el operador

El manifiesto admite programas de acontecimientos. El plano de control y la consola permiten añadir, sustituir,
desactivar o ejecutar programas durante el run. Cada cambio crea una versión con autor, instante efectivo y motivo
opcional; no cambia el pasado ni se hace pasar por configuración inicial.

Cada programa declara ID, versión, ámbito, disparador, condición, efecto tipado, selección de parámetros, prioridad,
límites y exposición. Se admiten disparadores por instante o recurrencia del reloj; ronda o interacción de un actor;
predicado físico; estancamiento individual o de equipo; y orden manual autenticada.

```json
{
  "id": "perturb-on-stall",
  "version": 1,
  "trigger": {
    "kind": "stagnation", "actor": "researcher-a",
    "signal": "researcher-a.progress", "window": 3, "predicate": "no_improvement"
  },
  "effect": { "type": "spawn_body", "parameters_from": "body-arrivals-v1" },
  "schedule": { "delay_ticks": 1, "cooldown_ticks": 20, "max_firings": 2 },
  "exposure": "sensors_only"
}
```

Las señales y efectos deben resolver a contratos registrados. Cada señal declara productor, frecuencia, unidad,
dirección de mejora, tolerancia y tratamiento de faltantes. `no_improvement` requiere una ventana completa de muestras
válidas sin mejora superior a la tolerancia; falta de datos no es estancamiento. Se admiten señales declaradas por
el investigador, indicadores operativos o jueces configurados. Un juez conserva entradas, regla, respuesta y consumo;
no existe un diagnóstico universal implícito.
En comparaciones de agenda frente a estancamiento, **el manifiesto fija antes del run el productor, la fórmula,
entradas, ventana y tolerancia de la señal**, y el investigador no puede sustituirlos. Una autodeclaración puede ser
entrada, pero entonces la condición se etiqueta `self_reported`, no diagnóstico independiente. Una señal que el
investigador configura o provoca expresamente es `requested_surprise`: pedir una perturbación es legítimo dentro de
su autorización, pero se registra y analiza separado de `operator_fixed`. Las etiquetas y cambios de versión forman
parte de la condición y de su identidad (§15.1); los faltantes no disparan ninguna de ellas.

Se evalúa al confirmar una frontera y se programa para una frontera futura. Una condición sostenida dispara una vez;
se rearma después de dejar de cumplirse y volver a cumplirse, respetando enfriamiento. Recurrencias temporales son
explícitas. Cada programa tiene máximo de disparos y gasto; no ejecuta cadenas recursivas en el mismo instante.

### 10.1 Modos y atribución

| Modo | Selección |
|---|---|
| Dinámica autónoma | Reglas físicas y azar, sin leer progreso del investigador |
| Agenda programada | Acontecimientos o distribuciones fijados antes del run |
| Perturbación reactiva | Estancamiento decide cuándo; tipo y distribución se fijan antes, sin elegirlos para resolver su hipótesis |
| Intervención adaptativa dirigida | Operador o tutor elige qué ocurre usando progreso o conocimiento del problema |

El modo reactivo consume un flujo propio de parámetros independiente del disparador. Añade acontecimientos con IDs;
no adelanta ni borra la agenda autónoma. Comparar tiempos de intervención requiere agendas de control declaradas;
no se presupone que las experiencias sigan siendo idénticas si cambian las acciones.

El operador puede cambiar qué ocurre en plena investigación: se registra como intervención dirigida. Las reglas
automáticas no leen exámenes reservados. Si una intervención humana usa conocimiento reservado, su atribución de ayuda
queda declarada; el resultado no se presenta como descubrimiento independiente de esa intervención.

Una perturbación física no consume `help-budget`, pero el finding registra intervenciones ambientales, señales y
selección adaptativa aparte. Cero mensajes de ayuda no significa ausencia de intervención. El consejo textual del
operador sí conserva su contabilidad de ayuda.

`sensors_only` sólo informa si un instrumento detecta consecuencias; no garantiza mensaje. `announce_action` añade
un anuncio del operador con detalle autorizado. No se disfraza de descubrimiento del sensor. Causa del disparo y
agenda permanecen restringidas salvo permiso experimental explícito.

Una perturbación respeta las leyes declaradas. Cambios de régimen admitidos son acciones versionadas del mundo y
forman parte de la tarea; nunca modifican silenciosamente el evaluador. Efectos con precondiciones inválidas se
rechazan y registran, no se sustituyen por otros convenientes.

## 11. Frontera de información

El registro autoritativo restringido contiene estados, agendas, disparadores, políticas internas y relaciones causales.
La vista de cada actor contiene sólo lo observado, consultado, recibido y producido con sus permisos. El auditor
puede inspeccionar el conjunto. Las credenciales no se incorporan a los registros de experimento.

Memoria, experiencia, instrumentos, consola de actor y ramas aplican la misma autorización. Hashes y referencias no
conceden acceso. Los IDs públicos no codifican causas ocultas. El paquete puede incluir material restringido para
verificación, pero los lectores del actor no lo exponen.

Las políticas físicas de otros actores no leen diarios privados. El monitor de estancamiento pertenece al plano de
control con entradas declaradas; esa excepción no concede acceso al resto del mundo. Compartir notas es una acción
explícita. Testimonios y medidas conservan sus procedencias aunque un actor los combine en una explicación.

## 12. Delegación y colaboradores

`delegate` sigue abriendo una investigación con presupuesto y acceso documental autorizado cuyo resultado vuelve
al solicitante. En sesiones vivas admite modos explícitos:

- `isolated`: nueva realización o copia autorizada, con identidad y linaje distintos. Valor predeterminado. Su global
  pertenece a esa realización, no a la del padre.
- `shared`: incorpora un investigador a la sesión actual con permisos concedidos. Puede afectar físicamente a todos
  y usar los canales autorizados. Nunca se presenta como ejecución aislada.

El run declara modos permitidos, concurrencia y profundidad; conserva límites vigentes cuando no se amplían. Si un
modo no puede cumplirse, se rechaza sin sustitución silenciosa.

Copias fijan snapshot, revisión de estado, versiones de actores y política de aleatoriedad futura. Repetir una
realización conocida o elegir otra semilla es legítimo si está autorizado; reproducir no equivale a leer la agenda
oculta. No se copian realizaciones reservadas ni se revelan agendas por delegar.

En modo compartido pueden comunicarse antes del resultado final por directos o global. Las entregas y costes se
registran. El resultado sigue siendo aportación, no orden. Terminar el solicitante cancela sus ramas dependientes por
defecto. El operador puede promover un colaborador a actor independiente, reasignando presupuesto explícitamente.

## 13. Recursos y ciclo de vida

Límites globales y por actor: tokens, llamadas, acciones, tiempo simulado, tiempo de pared, instrumentos, mensajes,
actores activos y almacenamiento. Junior, senior, ramas y actores del mundo se contabilizan por propietario y rol;
el total suma cada consumo una sola vez. Compartir mundo no crea presupuesto.

Reservas antes de inferir, actuar con coste o crear actores. Liquidación con gasto observado; retención explícita
para gasto incierto. Llamadas en curso pueden exceder límites comprobados entre llamadas: se limita salida y se declara
ese margen, sin confundir presupuesto con gasto exacto garantizado.

Un actor agotado deja de decidir; sus acciones físicas terminan o se cancelan según contrato. Los demás siguen si hay
recursos. Agotar la sesión detiene productores e inferencias de manera controlada y conserva parciales, pendientes y
consumo incierto, sin esperar indefinidamente.

Sesión: `created`, `running`, `paused`, `closing`, `completed`, `failed`. Actor: `ready`, `thinking`, `waiting`,
`exhausted`, `stopped`, `failed`. Completar significa cierre operativo, no éxito científico. Pausa simulada congela
reloj y agenda y drena o cancela inferencias con registro. Tiempo real sigue el contrato de §5.2. Retirada de un actor
no borra efectos físicos ni mensajes ya publicados.

## 14. Persistencia, reanudación y reproducción

El diario de sesión ordena commits con tiempo lógico y de pared: manifiestos, cambios, ventanas, vistas, intenciones,
conflictos, efectos, observaciones, mensajes, destinatarios, entregas, activaciones, disparos y recursos. Cada actor
mantiene su diario de investigación y ediciones enlazado mediante IDs. Snapshots incluyen operaciones pendientes y RNG
por flujo, no sólo el estado físico.

El coordinador usa escritura anticipada: prepara transición con ID e intenciones, ejecuta o recupera por ID, confirma
estado y outbox y luego distribuye. Publicación y entrega tienen claves estables, y recibo por actor y pregunta. Una
recuperación reconcilia transiciones preparadas antes de aceptar otras. Repetir una petición no avanza dos veces.

Servicios externos requieren idempotencia y consulta de estado para acreditar garantías completas. Si no las tienen,
se declaran efectos inciertos y no se promete exactamente una ejecución. Las respuestas LLM se guardan antes de actuar;
una llamada incierta no se repite suponiendo que no ocurrió.

El paquete incluye diarios, versiones, adjuntos compartidos, snapshots, programas, instrumentos, efectos externos
registrados y contabilidad, con hashes y permisos. `verify` comprueba referencias, entregas, transiciones y recursos,
distinguiendo integridad documental de reproducción de dinámica.

- Replay: sirve decisiones, efectos y entregas grabadas, sin modelos ni servicios vivos.
- Reejecución del mundo: aplica decisiones grabadas para verificar el adaptador; informa ruido o divergencia.
- Nuevo experimento: consulta de nuevo modelos y puede recorrer otra trayectoria aunque comparta semillas.

Una semilla no sustituye acontecimientos realizados. Se incluyen decisiones de actores, comunicaciones y cambios
manuales del operador. La reproducción del conjunto es requisito, no sólo la del investigador principal.

## 15. Evaluación e investigación sin etiquetas

Cada tarea declara si evalúa predicción, modelo explicativo ejecutable, objetivo de actuación o combinación con
criterios separados. La no estacionariedad no permite cambiar retrospectivamente el objetivo. La evaluación usa
realizaciones reservadas con actores y regímenes declarados. Información disponible, horizonte y, cuando corresponda,
predicciones probabilísticas o límite de predictibilidad evitan exigir predecir sucesos ocultos impredecibles.

Los checks están aislados: no reciben global exploratorio ni intervención manual adaptada a sus resultados. La
política de acontecimientos de evaluación se fija antes; las reglas de progreso exploratorio no se activan por
resultados del examen. No se permite observar ni modificar realizaciones reservadas desde herramientas del actor.

Puede conservarse una evaluación original sin perturbaciones para medir transferencia, informada aparte del mundo
vivo. Incluir perturbaciones en validación no destruye el significado de `holds`: define otro régimen que debe estar
especificado. Aceptar un artefacto no valida automáticamente su explicación.

El finding separa resultados individuales y colectivos; exposición, percepción, contraste y consecuencia; mensajes
recibidos, ayudas semánticas, intervenciones ambientales y coste completo. Contar hipótesis o sorpresas no es medir
aprendizaje. Una anomalía ignorada puede ser irrelevante; una hipótesis refutada puede haber sido informativa.

Comparaciones: aviso automático frente a consulta en la misma dinámica; agenda fija frente a disparo por estancamiento;
un actor frente a varios, con/sin comunicación, distinguiendo presupuesto y efectos físicos. Agendas fértiles e
irrelevantes estudian discriminación, no prueban por sí solas descubrimiento causal. Se examinan contrastes registrados.
Pocas realizaciones constituyen piloto descriptivo, no evidencia general de superioridad.

Sin etiquetas significa no entregar la explicación correcta al aprendiz. El operador puede conocerla para evaluar.
Aprendizaje entre runs exige declarar qué se conserva —memoria, métodos, reglas o parámetros— y probar transferencia
con realizaciones nuevas. Esta arquitectura no impone entrenamiento de pesos como requisito.

### 15.1 Resultados K1–K5 e identidad experimental

La integración amplía `lib/src/orchestra/results.ts`, `traces.ts` y `lib/src/runtime/generators.ts`; no crea un informe
paralelo incompatible. Cada actor conserva su finding y la sesión añade un agregado enlazado, con versión de esquema.

- **K1:** preservar O1 aceptación predictiva/modelo y artefacto, O2 evidencia discriminante, O3 adecuación a criterios
  previos y O4 recuperación mecanística cuando se pueda medir. No evaluable sigue siendo no evaluable. Añadir coste
  del mundo, sensores, comunicación e intervenciones a los costes por rol, con IDs de consumo únicos. Una rama
  compartida puede figurar en el desglose del solicitante y como actor, pero el agregado de sesión la suma una vez.
  Coste desconocido y reservas retenidas nunca son cero ni gasto confirmado. Latencia de sesión y tiempo de cómputo
  acumulado son magnitudes distintas.
- **K2:** agrupar por generador, mundo/condición, versión de código y criterios. Congelar referencias. No mezclar
  `operator_fixed`, `self_reported`, `requested_surprise`, intervención dirigida y ausencia de intervención.
- **K3:** declarar comparaciones antes del lote, incluidos modelos, señales, agendas, comunicación, presupuestos y
  límites de timeout. Las acciones divergentes se conservan; no se fuerza a los actores a producir datos pareados.
- **K4:** añadir ventanas, despertares, lotes, conflictos, mensajes y entregas, vigilantes, disparos, timeouts y lecturas
  posteriores a las trazas. Son descripciones del proceso, no puntuaciones de creatividad o método.
- **K5:** la unidad independiente es la sesión/realización, no sus actores, ventanas o mensajes. Las comparaciones
  pareadas usan realizaciones independientes por par y respetan la dependencia dentro de sesión. Con datos insuficientes
  se informa así; no se aplican controles estadísticos como si cada actor fuese una réplica independiente.

El manifiesto completo, saneado de credenciales, se conserva con hash canónico. No se incorpora sin distinguirlo todo
al hash del generador: se mantiene la separación actual entre generador y población del mundo.

`generatorOf` incorpora modelos y ajustes de junior/senior/investigadores, límites, reloj y resolución de ventanas,
reactividad, permisos de comunicación, política de delegación, señal de estancamiento y política de intervención
adaptativa. El hash de condición del mundo incorpora adaptador, leyes, regímenes, políticas de actores del entorno,
sensores iniciales, distribuciones y agendas físicas, y evaluador. La semilla realizada y el estado inicial identifican
la realización, no un nuevo generador por réplica. La clave de comparabilidad incluye ambos hashes y criterios.

Se excluyen nombres operativos: directorios, archivos de diarios o libros, endpoints equivalentes, PID y marcas de
pared. Las referencias operativas se resuelven a hashes de contenido; identidades se normalizan preservando roles,
conexiones y permisos. Cambiar un nombre de ruta no cambia condición; cambiar código de sensor o agenda sí. Un endpoint
que cambia el comportamiento del servicio requiere otra identidad/versionado del adaptador, no se oculta como ruta.

Cambios manuales producen revisiones enlazadas y un historial de intervenciones. El run se marca `adapted` y no se
agrupa como condición fija original; mantiene configuración inicial y efectiva. No se deriva identidad de las salidas
del modelo o del éxito observado. Pruebas obligatorias: misma condición en otras rutas conserva hashes; cambiar señal,
regla, permisos o política cambia la identidad correspondiente; variar semilla mantiene generador y distingue réplica.

## 16. Configuración, herramientas y consola

Un manifiesto `living-world@1` se ejecuta con `lab live <manifest>` y puede referenciarse desde batch mediante `session`.
Contiene adaptador y versión, reloj, actores y modelos, junior/senior, permisos, global, instrumentos iniciales,
programas, presupuestos y evaluaciones. Se validan referencias, efectos, disparadores, aislamiento y límites antes
de consumir inferencia. No hay recursos ilimitados implícitos.

Invariantes de integración:

- Sólo se integra el investigador asistido (§5.3); no se modifica el investigador puro congelado.
- Conversación append-only: avisos, respuestas diferidas y reflejos al senior se añaden, no se reescriben. Debe seguir
  pasando `lib/test/append-only.test.ts` y añadirse cobertura de ventanas, mensajes y reanudación.
- Sandbox de procesos locales, **sin Docker como dependencia ni requisito**. Límites y permisos del sandbox existente
  se aplican a instrumentos, políticas y servicios; no se ejecuta código del actor dentro del coordinador con privilegios.
- La terminología normativa es «investigador reactivo» para despertar por percepción (§9), y «perturbación reactiva
  del entorno» para disparar por estancamiento (§10). El nombre de condición y el finding distinguen ambos ejes.

Herramientas del actor: acciones del mundo, `wait`, instrumentos, memoria, lectores de canal, `message.send`, `share`
y `delegate`, según permisos. Rechazos explícitos para acciones desconocidas o no autorizadas. Los mensajes no son
un acceso alternativo al plano de control.

Operador: inspeccionar, pausar, reanudar, cerrar, incorporar/retirar actores, revisar reservas, enviar directos o global,
programar/desactivar perturbaciones y ejecutarlas manualmente. Mutaciones pasan por el coordinador y se registran.

La consola ofrece estado vivo y timeline: actores, operaciones, reloj, acontecimientos, sensores, directos, global,
disparos, ramas y costes. Distingue vista de auditor de lo percibido por cada actor. Permite seguir un acontecimiento
hasta medición, entrega y decisión, y un global hasta recibos individuales. Ocultar en UI no sustituye autorización.

## 17. Construcción integrada y aceptación

Orden por dependencias: adaptador/coordinador; persistencia y recursos; canales; actores e instrumentos; reactividad
y programas; delegación; evaluación, paquete y consola. Es un orden de construcción de la arquitectura completa,
no una decisión de dejar capacidades para otra SPEC.

### 17.1 Hitos verificables

| Hito | Entrega integrada | Puerta de aceptación |
|---|---|---|
| H1 | Mundo persistente, un asistido real en su bucle, puente Objective, diario y recursos | Prueba 1; prueba 4 sin delegar (ignorar o contrastar); prueba 12 para transiciones y entregas de las observaciones de un actor; prueba 17 sin retirada de actores. Una ronda cruza varias ventanas, consulta sin avanzar y propone sin actuar; append-only |
| H2 | Varios actores, autoridad exclusiva del junior, canales y compartición | Pruebas 2, 5, 6, 9, 11 y 15; prueba 12 para publicación y entrega de mensajes; prueba 17 con retirada de actores; sin ventaja por orden de respuestas dentro del plazo; replay del intercambio |
| H3 | Vigilantes, reactividad y todos los disparadores del operador | Pruebas 3, 7 y 8; señal fija frente a autodeclarada; sin duplicación de activaciones ni avance gratis |
| H4 | Ramas aisladas/compartidas y protocolo externo | Pruebas 10 y 14; prueba 4 con delegación; recursos, cierre y recuperación del árbol y servicio simulado |
| H5 | Integración de resultados, consola y paquete completo | Pruebas 13, 16 y 18; hashes de §15.1, agregación sin doble coste ni pseudorreplicación; conjunto completo de regresiones |

Una prueba repartida entre hitos sólo cuenta como superada cuando lo está en todas sus partes.
Cada hito entrega un escenario ejecutable con decisiones simuladas, diagnósticos de fallo y verificación offline.
Permite medir y corregir antes del siguiente. H1 ya incluye propuestas y evaluación: no deja el puente científico
para el final. Los hitos posteriores amplían la cobertura del mismo contrato. La aceptación final exige todas las
pruebas con el conjunto integrado; aprobar un hito no autoriza a declarar completa la arquitectura ni a recortar alcance.

### 17.2 Mundo y batería de aceptación

Se implementa un mundo interno de referencia, pequeño y determinista: muestras persistentes sobre rejilla, recursos,
contaminación, limpieza y actores que consumen o trasladan recursos. Leyes fijadas por semilla, accesibles sólo por
percepciones. Dos investigadores con objetivos configurables y una política competidora fija o adaptativa. Sensores
miden muestras sin anunciar causas. Hay acontecimientos fértiles e irrelevantes y acciones para reproducir contrastes.
Esta base verifica coordinación sin depender de Blender; adaptadores externos cumplen el mismo contrato y declaran
sus garantías. El piloto de partículas puede usarlo sin definir otra arquitectura.

Pruebas de aceptación con decisiones simuladas, sin inferencia de pago:

1. El mundo avanza con actores esperando; una muestra cambia y se vuelve a observar en el mismo estado persistente.
2. Actores parten de una revisión común; conflictos y acciones compatibles se resuelven reproduciblemente.
3. Un acontecimiento puede no percibirse; un vigilante permite observar y despertar sin revelar la causa.
4. Ignorar, contrastar o delegar son posibles, sin respuesta metodológica obligatoria.
5. A→B no llega a C; global llega a miembros autorizados con recibos separados e historia controlada para nuevos actores.
6. Compartir un artefacto conserva versión; datos no autorizados siguen inaccesibles vía experiencia y ramas.
7. Disparadores por tiempo, ronda, interacción, estado, estancamiento y orden manual producen efectos registrados;
   faltantes no equivalen a estancamiento, condiciones sostenidas no producen tormentas de eventos.
8. Perturbaciones y consejos se atribuyen aparte; selección reactiva respeta su flujo de parámetros declarado.
9. Junior y senior comparten vista autorizada; despertar un rol no regala recursos ni permisos al otro.
10. Delegación aislada no modifica al padre; compartida sí interactúa y se comunica; modo no disponible se rechaza.
11. Límites de población, avisos, vigilantes, inferencias y mundo evitan ejecución ilimitada y doble contabilidad.
12. Caídas antes/después de transición, publicación y entrega no duplican efectos ni pierden avisos silenciosamente.
13. Replay completo sin red; orden de llegada de respuestas dentro de ventana no altera resolución salvo timeouts
    registrados. Cada destinatario recupera su propio cursor.
14. Servicio externo simulado verifica idempotencia, retrasos, lagunas y pausa no soportada sin prometer garantías falsas.
15. Adversarios y poblaciones sólo acceden a sus vistas; una hipótesis comunicada voluntariamente sí puede ser leída.
16. Evaluaciones reservadas no reciben mensajes ni perturbaciones exploratorias ni filtraciones a instrumentos.
17. Pausa, cierre, agotamiento y retirada preservan efectos y operaciones pendientes conforme al manifiesto.
18. Consola y paquete permiten reconstruir lo ocurrido y distinguirlo de lo percibido por cada actor.

La prueba real posterior usa el mismo mundo con investigadores LLM y presupuesto acotado. Sigue una sorpresa hasta
su contraste y decisión, y una comunicación hasta su efecto. Un resultado negativo fundamentado es válido: resolver
el mundo no es condición para acreditar la infraestructura.

**El arnés proporciona un mundo que continúa, medios para percibirlo y actores que pueden hablar y actuar en él.
Qué merece convertirse en investigación sigue siendo decisión del investigador.**

## 18. Implementación

### 18.1 H1 (27/10/2026)

Código en `lib/src/living/`: `world.ts` (contrato `LivingWorldAdapter`, `LivingSession` como coordinador y `WorldJournal`),
`bridge.ts` (puente con las rondas del asistido) y `manifest.ts` (`living-world@1`, `lab live <manifest>`). Mundo de
referencia en `lib/src/worlds/plates/` (`plates@1`): pozos con nutriente y colonia, crecimiento, siembra por vecindad,
contaminación no percibida, llegadas de contaminación al azar en el mundo compartido y marcas sin consecuencia.
Pruebas en `lib/test/living-world.test.ts`.

Decisiones tomadas al implementar:

- **Integración.** `Lab.living` declara un mundo vivo. El runner abre una única sesión por run; `act.start` nunca se
  llama. Un acto es una intención; lo que el investigador percibe de ella es un `Segment` (proyección por tick, sesión,
  intervalo, revisiones), expuesto como episodio del laboratorio, de modo que `view`, `table`, `measure` e instrumentos
  propios funcionan sin cambios.
- **Ventana y paso.** Los actos de una respuesta forman un lote, sellado al terminar el paso (`LawSessionHost.endStep`) y
  aplicado tras la barrera; su resultado vuelve en la siguiente respuesta. Una consulta del mundo posterior a un acto en
  la misma respuesta no se responde. Un lote cuyos actos se rechazan todos no se sella: la respuesta cuenta como de
  consultas.
- **Llamadas por ventana.** Cuentan los pasos de investigación; las respuestas rechazadas por formato no cuentan. Al
  alcanzar el límite se sella un lote vacío y la ventana avanza sin el investigador.
- **Rondas.** Una propuesta, un cierre de ronda o una ronda sin propuesta ceden un lote vacío. La reflexión final no
  avanza el mundo.
- **`wait`.** Cuenta como un acto y va sola en su respuesta. Puede cruzar varias ventanas; lo observado se une en un
  único segmento.
- **Exploración.** Las ventanas del mundo previas a la primera ronda; sus segmentos son episodios del entorno.
- **Evaluación.** Se hace en realizaciones reservadas del lugar, nunca en el estado compartido. Régimen declarado: sin
  llegadas de contaminación, con dos pozos contaminados desde el inicio y 12 ticks por episodio.
- **Diario.** Escritura anticipada bajo claves propias (`wN.prepare`, `wN.commit`, `d.<actor>.<clave>`, `close`). Un run
  reanudado deriva cada entrada de nuevo y la compara con el diario del run que continúa: la igual se conserva, la
  distinta se registra como divergencia (`world_diverged`) y nunca se escribe dos veces.
- **Fuera de H1, con rechazo explícito.** Otros actores y más investigadores, y el reloj `realtime`, se rechazan en el
  manifiesto. La delegación en un mundo vivo se rechaza (§12, H4) y `--own-tests` también, porque arranca episodios de
  nuevo. El investigador puro no entra.

Pendiente tras H1: varios actores, canales y autoridad exclusiva del junior (H2, §18.2); vigilantes, reactividad
y programas del operador (H3); ramas aisladas o compartidas y servicio externo (H4); paquete con el diario del mundo,
consola e identidad §15.1 (H5); y la prueba real con un investigador LLM en `plates@1`.

### 18.2 H2 (27/10/2026)

Código: `LivingSession` ampliada en `lib/src/living/world.ts`; el puente asíncrono `bridge.ts`; `run-session.ts`
(sesión compartida en un proceso) y `lib/scripts/run-session.ts`; políticas de `plates@1`. Pruebas en
`lib/test/living-world-h2.test.ts`.

Decisiones tomadas al implementar:

- **Contrato.** `advance(state, intents)` se separa en `apply(state, intent)` y `advance(state)`. Cada intención se
  revalida sobre el estado que dejaron las anteriores de la ventana, en el orden rotatorio fijado por la semilla. Si una
  precondición ya no se cumple, es un conflicto sin efectos; las acciones compatibles se aplican juntas.
- **Miembros.** Declarados con `ActorDecl`. Los investigadores reciben las acciones del mundo que no están marcadas como
  `granted`; las demás solo se conceden explícitamente (`drain` en `plates`). Las políticas no investigadoras
  (`policy`, `adversary`, `population`) deciden al abrirse cada ventana, sobre la misma revisión, con su vista, su bandeja y
  su estado propio; su estado queda en el diario (hash en cada `prepare`, completo en `close`).
- **Barrera.** `commit(actor)` espera a que se aplique la ventana; `settle()` la aplica cuando todos los que deciden han
  sellado o duermen. Hace falta al menos un investigador activo: los actores no investigadores no hacen avanzar el reloj por
  sí solos. Con `window_ms`, un investigador que no sella a tiempo recibe un no-op que queda registrado (`wN.timeout`), y
  un lote decidido sobre una revisión ya pasada se rechaza como tardío.
- **Mensajes.** `send` a un miembro o a `global`. El origen, el id, la ventana y el orden los pone la sesión. Se entregan
  cuando se confirma la ventana en que se publicaron, entre decisiones, a través del canal del investigador (como
  `actor:<id>`). Cada destinatario tiene su recibo (`r.<actor>.<id>`). Un mensaje global cuenta una vez y sus entregas,
  una por receptor. Un miembro nuevo no recibe la historia; la lee si tiene permiso (`history`). Sin
  `messages_per_window` nadie puede publicar. Un mensaje que excede su tamaño se rechaza, nunca se recorta.
- **Compartir.** `share` envía una copia inmutable con `version_hash`, y el receptor la guarda como episodio
  `from-<autor>-<nombre>`. Sólo se comparte material propio: episodios propios, del entorno o de sus checks, y documentos.
  No se pueden compartir validaciones ni lo recibido de otro. Las referencias de un mensaje se dan en nombres del autor y
  no dan acceso.
- **Junior y senior.** Sólo el junior es miembro del mundo; el senior ve lo que se le entrega al junior a través del espejo
  de su canal y no tiene ninguna vía para actuar.
- **Retirada.** Al terminar su run, el investigador se retira: un lote ya sellado se aplica, lo comenzado sigue sus leyes y
  lo publicado permanece. Nadie espera a un miembro retirado.
- **Sesión compartida.** `runLivingSession` ejecuta a los investigadores a la vez, en un mismo proceso y un mismo mundo, cada
  uno con su run, y cierra la sesión cuando se va el último. El manifiesto `living-world@1` admite varios miembros y exige
  `window_ms` cuando hay más de un investigador. `lab live` lanza un run propio si hay un único investigador sin mensajes,
  y una sesión compartida en cualquier otro caso.

El orden en que llegan las respuestas, dentro del plazo, no cambia nada: dos ejecuciones con latencias invertidas
producen el mismo diario del mundo. Queda pendiente la reanudación de una sesión compartida completa: hoy se reanuda el run
de un investigador solo.

### 18.3 Revisión externa de H2 conciliada (27/10/2026)

Pruebas en `lib/test/living-world-review.test.ts`.

- **Cierre.** El cierre queda registrado bajo la clave de dónde ocurrió (`close@w<n>.t<tick>`) y las pausas se numeran.
  Así, una continuación que llega más lejos cierra con su propia entrada, nunca hereda la del run que continúa y no
  produce una divergencia.
- **Tiempo límite.** El temporizador de la ventana se arma en cuanto un investigador sella o se duerme: un `wait` cuenta,
  también el de la exploración. Si otro miembro no responde, recibe un timeout y el mundo sigue.
- **Orden de los mensajes.** El id de un mensaje es `message:w<ventana>.<autor>.<k>`. Su `seq` se asigna al confirmarse la
  ventana, ordenando por autor y después por el orden propio de cada autor; el `commit` registra ese orden. Quién publica
  antes deja de cambiar lo que leen las políticas y, por tanto, el mundo.
- **Investigador solo.** Conserva el id y las acciones de su declaración: el manifiesto pasa `--actor` y `--actions`
  (`none` si la lista está vacía), y el runner los usa al abrir la sesión.
- **Base de la decisión.** La revisión sobre la que descansa una respuesta se fija al formular la pregunta
  (`LivingBridge.decide`, desde el `halt` previo a cada consulta). Un `observe` dentro de la misma respuesta ya no la cambia,
  así que un acto decidido sobre una revisión superada sigue siendo tardío.
- **Nombres compartidos.** El nombre de un episodio compartido es inyectivo: el id del autor se escribe escapando lo que el
  nombre de un episodio no admite (`-c` mayúscula, `-u` guion bajo, `-h` guion) y se separa con `--` del nombre propio
  (`from-a--act3`).
- **Delegación del senior.** En un mundo vivo también se rechaza la delegación del senior, igual que la del junior.

Segunda revisión (27/10/2026):

- **Ficheros por investigador.** El fichero de cada investigador usa el mismo nombre inyectivo (`actorSlug`), en
  minúsculas y con escapes: `Alice` y `alice` son dos ficheros también donde el sistema de archivos no distingue
  mayúsculas.
- **Cierre de una continuación.** El cierre lleva también el tramo de ejecución que lo produjo, que es el nombre de su
  propio diario (`close@w<n>.t<tick>.<tramo>`). Una continuación cierra como ella misma aunque el reloj no se haya movido.
- **Mensajes en el horizonte.** Al alcanzarse el horizonte se rechaza todo mensaje nuevo, porque ninguna ventana lo
  llevará; nunca se publica para perderse.

### 18.4 H3 (27/10/2026)

Código en `lib/src/living/events.ts`: `Agenda` (programas y señales) y `Watchers`, integrados en `LivingSession`; efectos de
`plates@1` (`contaminate`, `nutrient_pulse`, `smudge`); `lab world`. Pruebas en `lib/test/living-world-h3.test.ts`.

Decisiones tomadas al implementar:

- **Programas.** Cada programa declara disparador, efecto tipado del adaptador, calendario (`max_firings` obligatorio,
  `delay_ticks`, `cooldown_ticks`), prioridad y exposición.
  - Instantes y recurrencias de la agenda se programan exactamente en su tick al abrirse la ventana.
  - Los demás disparadores se evalúan al confirmarse una ventana y se programan para un tick posterior. Son
    `round`, `interaction`, `state` (predicado en el sandbox sobre la instantánea), `stagnation`, `request` y `manual`.
  - Una condición sostenida dispara una vez y se rearma cuando deja de cumplirse.
  - Lo no evaluable (predicado que falla, muestras insuficientes) no dispara ni rearma.
  - Un efecto cuya precondición no se cumple se registra como rechazado y no se sustituye por otro.
- **Parámetros.** Si el programa no los fija, salen del flujo propio de cada programa: el disparo k recibe lo mismo
  se dispare cuando se dispare.
- **Modo y etiqueta.** Cada disparo lleva modo y etiqueta, que nunca se mezclan.
  - Modos: `agenda`, `reactive` y `directed`, este último para lo añadido o disparado por el operador durante el run.
  - Etiquetas: `operator_fixed`, `self_reported`, `requested_surprise` y `directed`.
  - El resumen de la sesión cuenta las intervenciones por modo y etiqueta, aparte de la ayuda.
- **Señales.** Las fija el manifiesto, con productor, unidad, dirección y tolerancia.
  - `checks` lo produce el arnés tras cada check (proporción de puntos exactos); una ronda sin check aporta una muestra
    faltante.
  - `self_reported` sólo lo reporta su propio investigador (`progress`).
  - `no_improvement` exige una ventana completa de muestras válidas y un mejor valor previo con el que comparar.
- **Vigilantes.** `watch` registra versiones de una medida que se ejecuta en el sandbox sobre lo que su dueño puede
  percibir (`frame`, `previous`, `tick`), con cadencia, condición, enfriamiento, vigencia y máximo de avisos.
  - Miden aunque el dueño no decida.
  - El aviso llega como lectura de `instrument:<id>`: dice qué se midió, nunca la causa.
  - Un fallo es un aviso de fallo; tras tres fallos el vigilante se detiene.
  - Los sensores preinstalados usan el mismo contrato. Sin `limits.watchers`, nadie puede registrar vigilantes.
- **Investigador reactivo.** `wait` con `wake_on` (`observation`, `message`), dentro de la política `activation` declarada
  para el actor (`max` obligatorio, `cooldown_windows`).
  - El despertar se produce al confirmarse una ventana, como mucho una vez por ventana.
  - No cuesta decisiones ni hace avanzar el reloj de más.
- **Exposición.** `sensors_only` no avisa a nadie. `announce_action` publica un anuncio del operador (`announcement`),
  distinto de un aviso de sensor y que no consume ayuda.
- **Control durante el run.** `lab world <run> add|replace|disable|fire` crea una orden (`kind: world`, no ayuda) que se
  aplica al abrirse la siguiente ventana, registrada con quién y por qué (`prog.<id>`). Un run que continúa el registro la
  vuelve a aplicar en la misma ventana.

Pendiente: activación reactiva propia del senior y señales producidas por jueces configurados.
