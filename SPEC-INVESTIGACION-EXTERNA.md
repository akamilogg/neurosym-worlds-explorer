# SPEC · Investigación con fuentes externas y adquisición de métodos

Estado (13/11/2026): **propuesta para implementar; ninguna de las entregas IE1–IE6 se declara hecha**. Revisada el
13/11/2026 contra el código y las reglas del proyecto (§13): la lista blanca es el acceso por defecto, la web pública
se activa explícitamente, un mundo puede negarse a las fuentes externas, y las piezas que chocaban con lo construido
(clases de petición, identidad de los ensayos, procedencia de lo aprendido) quedan resueltas.

Se apoya en [fuentes y experiencia](SPEC-INVESTIGADOR-ASISTIDO.md),
[delegación](SPEC-DELEGACION-INVESTIGACIONES.md), [operadores y senior](SPEC-ORQUESTADOR.md),
[canal de mensajes](SPEC-CANAL-MENSAJES.md), [mundo vivo](SPEC-ACONTECIMIENTOS-DEL-MUNDO.md),
[artefactos](SPEC-MUNDO-ARTEFACTOS.md) y [edición de pesos](SPEC-EDICION-PESOS.md).
La separación de datos y los veredictos siguen [SPEC-VALIDEZ-MEDIDA](SPEC-VALIDEZ-MEDIDA.md).

## 1. El problema que resuelve

Hoy el operador humano aporta muchas de las técnicas nuevas: encuentra un artículo o implementación, reconoce una
conexión con el problema y propone probarla. El investigador puede explorar dentro de las capacidades habilitadas,
pero depende del operador para ampliar parte de su repertorio.

Queremos que también investigue **con qué métodos investigar**: buscar información que aún no tiene, leerla,
relacionarla con el trabajo en curso, adaptar mecanismos de otros problemas, construir pruebas y compartir lo que
encuentre. Puede hacerlo el propio investigador, una rama, el senior o un operador autónomo que acompañe varias tareas.

La web es un entorno documental que cambia. Puede aportar una pista pedida por el investigador o una novedad que un
actor encuentra por iniciativa propia. La capacidad funciona sin senior y sin que una persona nombre la técnica que
debe encontrarse. Descubrir, adaptar y combinar métodos forma parte de la búsqueda observable del proyecto.

El resultado útil es abrir o descartar una dirección con fundamento, o producir un procedimiento que se pueda probar.
Una lectura interesante, una técnica popular o muchos enlaces no demuestran por sí solos progreso.

## 2. Decisiones de arquitectura

1. **Una capacidad común de fuentes.** Junior, senior, ramas y operador usan las mismas herramientas de búsqueda y
   lectura, con permisos y presupuesto propios. No se crea una clase de modelo «generador de hipótesis».
2. **El investigador decide el recorrido.** Puede buscar, experimentar, volver a leer, combinar ideas, delegar o
   terminar. No se codifica una secuencia obligatoria ni un número de hipótesis, fuentes o dominios.
3. **Se conserva la procedencia.** Una fuente externa, una interpretación del agente y una observación del mundo son
   hechos distintos. Los mensajes de investigación no adquieren autoridad de orden por pasar por el canal del operador.
4. **Las técnicas no son una lista cerrada del prompt.** Las recetas existentes siguen disponibles. El agente puede
   construir procedimientos ejecutables dentro del contrato de entradas, salidas y recursos del laboratorio (§8).
5. **El criterio de éxito del mundo permanece fijo.** Leer un artículo o ejecutar un procedimiento propio no concede
   acceso a los casos reservados, cambia `holds` ni sustituye al evaluador por el resultado que el programa declare.
6. **El arnés conserva y limita; el agente interpreta.** No puntúa «creatividad», no fuerza salir de un dominio y no
   decide que una analogía es pertinente. Se pueden aprender políticas de búsqueda e intervención sobre estas trazas.
7. **Activación explícita.** La capacidad se habilita por configuración. El investigador puro conserva su condición;
   no recibe herramientas ni mensajes externos accidentalmente por pertenecer a un equipo que sí los utiliza.
8. **La lista blanca por defecto; la web pública, sólo activada.** El operador fija los orígenes permitidos (la regla de
   A6). Abrir la web pública es una decisión explícita del operador en la configuración, nunca un valor por defecto.
9. **El mundo puede negarse.** Un laboratorio cuya verdad está documentada fuera (su respuesta publicada) declara que no
   admite fuentes externas, y se respeta: ni lista blanca ni web pública llegan a quien investiga ese mundo. La
   metainvestigación no la puede bloquear el mundo: la experiencia de otros runs, el propio registro del investigador y
   los resultados de sus ramas siguen disponibles (§4.1).

## 3. Lo que existe y lo que hay que construir

| Pieza | Estado de partida | Cambio de esta spec |
|---|---|---|
| `learn/assisted/sources.ts` | `list`, `open`, `find`; archivos y URL autorizados; lecturas grabadas | Descubrir fuentes con `search`, navegar enlaces y conservar versiones citables completas |
| `learn/assisted/session.ts` | Herramientas adicionales del asistido y cuaderno | Integrar las nuevas operaciones mediante el mismo despacho de herramientas |
| `orchestra/agent-operator.ts` | Seguimiento, memoria, mensajes y delegación; el senior no despacha lecturas web | Darle el mismo acceso a fuentes y permitir sesiones documentales con presupuesto propio |
| `learn/assisted/delegation.ts` | Ramas, fondos, reconciliación, resultados y acceso al trabajo previo | Herencia explícita de fuentes y ramas sin laboratorio experimental |
| `runtime/control.ts`, canal y mundo vivo | Mensajes, autores, entregas y actores | Operador con búsqueda autónoma, activaciones registradas y resultados dirigidos o compartidos |
| Artefactos y programas de edición | Versiones de código, ejecución y ediciones construidas por programas | Importar resultados documentales como entradas; ejecutar procedimientos adquiridos |
| `junior/train.ts` | Recetas de entrenamiento enumeradas | Una receta por programa, validada por el host, sin exigir una receta nativa por cada algoritmo descubierto |

Las extensiones se implementan por composición. No se duplica `LawSession`, el cuaderno, el sistema de ramas, el
ledger de trabajos ni el transporte de mensajes. Para una tarea documental se reutiliza el ciclo de investigación,
se omiten los hooks de evaluación del mundo y se permite cerrar con informe; no se inventa una ley para poder terminar.

## 4. Configuración, permisos y acceso

Un fichero `external-research@1`, cargado con `--external-research <file>`, declara capacidades y bolsas. La biblioteca
acepta el mismo objeto. Ausente: comportamiento actual, incluidas las fuentes A6 que ya estuvieran autorizadas.

```json
{
  "format": "external-research@1",
  "search": { "provider": "brave", "max_results": 10 },
  "web": { "access": "allowlist", "allow": ["arxiv.org", "https://github.com/"], "deny": [], "max_document_bytes": 10485760 },
  "budget": { "search_calls": 30, "fetch_calls": 90, "download_bytes": 104857600 },
  "branches": {
    "inherit_sources": true,
    "budget": { "search_calls": 8, "fetch_calls": 24, "download_bytes": 20971520 }
  },
  "execution": { "profiles": [] }
}
```

Los números del ejemplo son una configuración, no umbrales metodológicos. Los límites deben ser enteros finitos y no
negativos; cero deshabilita la operación correspondiente. `web.access` es `allowlist` por defecto, con `allow`: los
dominios o prefijos que el operador permite, como en A6. `public` sólo vale escrito expresamente; una configuración que
lo omite es `allowlist`, y una lista vacía no permite nada. `deny` prevalece en los dos. Los orígenes locales siguen
usando el permiso de A6.
`branches.budget` fija el máximo y el valor por defecto de una rama; ésta puede solicitar menos. Sin esa bolsa, no
hereda llamadas de red, aunque puede leer los snapshots concedidos. Antes del lanzamiento se reservan las tres unidades.

- `allowlist` autoriza los orígenes listados: una búsqueda devuelve resultados de cualquier dominio, pero sólo se abren
  los permitidos; los demás responden `not_allowed`, con su dominio, para que el operador decida si lo añade.
- `public`, activado expresamente, autoriza consultar direcciones web públicas, incluidas las encontradas al seguir
  enlaces. No requiere que el humano adivine los dominios útiles. No autoriza archivos locales, intranet ni servicios de
  la máquina. Que esté activado queda en la configuración del run y en su registro.
- Comprobar destino y redirecciones en cada salto. La búsqueda no concede permisos que la lectura no tenga. No se
  reenvían credenciales del proveedor a los documentos; las claves quedan en el proceso anfitrión.
- La consulta escrita por el agente es lo que se envía al buscador. No se adjunta automáticamente el diario, código
  privado o contexto completo. En entornos privados el operador delimita qué material puede salir en consultas.
- Una rama hereda como máximo los permisos del solicitante. Su bolsa se reserva del fondo que la lanza; heredar
  capacidades no copia el saldo. Un operador autónomo puede tener permisos propios concedidos al iniciarlo.
- Los perfiles de ejecución los habilita el operador al configurar el laboratorio. Encontrar código no concede
  permiso para ejecutarlo, instalar dependencias o modificar el arnés anfitrión.
- El texto de páginas y resultados se entrega como contenido de una fuente: nunca como instrucciones del sistema,
  cambios de permisos ni órdenes del operador. Esta separación se prueba también con documentos que pidan hacerlo.

Una capacidad ausente responde `unavailable` o `not_allowed`, con motivo. No se representa como búsqueda sin resultados.
El inventario efectivo de herramientas y límites se muestra al actor y queda en el registro.

### 4.1 Mundos que no admiten fuentes externas

Un laboratorio declara `externalSources: { admitted: false, why: "..." }` cuando lo que se investiga en él está
documentado fuera y leerlo contaminaría la medida: el investigador dejaría de investigar un mundo desconocido. Es una
declaración del mundo, no una opción del run, y nadie la levanta desde la configuración.

- **Qué se niega:** las fuentes externas, es decir, los orígenes de la lista blanca (A6, locales o web) y la web pública.
  Las herramientas no se anuncian a quien investiga ese mundo y, si se piden, responden `not_allowed` con el motivo del
  mundo. Vale para el investigador, el senior, las ramas que trabajan en ese mundo (`world: "assigned"`) y las
  contribuciones: una contribución que cite fuentes externas no se entrega a un investigador de ese mundo.
- **Qué no se niega:** la metainvestigación. La experiencia de otros runs (`--experience`), el propio registro del
  investigador y su memoria selectiva, los resultados de sus ramas y los tablones de su equipo siguen disponibles. El
  mundo no los puede bloquear.
- **Quién lo declara al principio:** `c302nav` y `c302closed`, cuyo circuito es el conectoma publicado de *C. elegans*
  con literatura que describe su mecanismo. Los mundos generados por semilla (`cells`, `orbit`, `particles3d`, `tank`,
  `messages`, `plates`, `grid`) no tienen respuesta publicada y no la declaran; el de artefactos y el del junior tampoco,
  porque traer métodos de fuera es justo lo que se busca en ellos. Un laboratorio puede cambiar su declaración con su
  motivo; la prueba de §12 recorre todos.

### 4.2 La configuración forma parte de la identidad

Un ensayo con acceso externo y otro sin él no son el mismo ensayo. La configuración `external-research@1` efectiva, por
su hash, y la declaración del mundo entran en la identidad de un ensayo del metalaboratorio y en la del run que la usa:
el manifiesto de un metalaboratorio la fija para todos sus casos, igual que los argumentos del junior.

## 5. Buscar, leer y citar

### 5.1 Búsqueda

Extender el vocabulario de `Sources`, sin cambiar el significado de `find`, que busca dentro de documentos conocidos:

```json
{
  "investigate": [{
    "search": {
      "query": "methods for adapting frozen models with very few changed parameters",
      "limit": 8
    }
  }]
}
```

Contrato `source-search@1`: `query` no vacía, `limit` entre 1 y el máximo configurado; opcionales `cursor`, `language`,
`freshness` (`day`, `week`, `month`, `year`). El cursor pertenece a una búsqueda registrada y mantiene sus filtros.
Los campos desconocidos o no soportados se rechazan antes de llamar al proveedor.

La respuesta contiene `id`, consulta efectiva, proveedor, instante de recuperación, `results` ordenados y `next_cursor`
si existe. Cada resultado tiene `id`, `title`, `url`, `snippet` y, sólo si el proveedor la da, fecha de publicación.
Se distingue fecha de publicación de recuperación. Un resultado es una pista: su snippet no cuenta como lectura del
documento. Se registra la respuesta del proveedor y la normalizada, con sus hashes y la versión del adaptador.

El primer adaptador real es HTTP para Brave Web Search, sin SDK: `GET /res/v1/web/search`, `q`, `count` y `offset`;
`X-Subscription-Token` procede de `WEB_SEARCH_KEY`. Mapea los filtros declarados, `web.results` y la indicación de más
resultados; no usa una respuesta generada por otro LLM como sustituto de los documentos.
[Contrato del proveedor consultado el 12/11/2026](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started).
El endpoint de producción y la versión del adaptador quedan identificados; los tests inyectan transporte y respuesta.

El proveedor es reemplazable por la interfaz `SearchProvider.search(request, signal)`. Se entrega un adaptador real,
además del simulado de pruebas. El arnés conserva el orden que devuelve; la selección de qué leer es del agente.

### 5.2 Lectura y navegación

Reutilizar `open` y `find`. Añadir `{"links": "<source-id>"}` para listar enlaces del documento ya capturado, con sus
textos y destinos resueltos contra la URL final. El agente abre el destino que elija mediante `open`; listar enlaces no
descarga destinos ni altera permisos. Los resultados de búsqueda también pueden abrirse por su ID.

Cada descarga produce un snapshot inmutable `source-document@1`:

- URL solicitada y final, redirecciones, tipo de contenido, recuperación y estado HTTP;
- cuerpo original por SHA-256 completo; texto extraído, numeración de líneas y enlaces por hash;
- extractor y versión, advertencias y truncamiento si lo hubiera;
- vínculo al actor y operación que lo adquirieron.

`open` sobre una URL obtiene una nueva observación, aunque su contenido coincida con otro snapshot. `open` sobre el ID
de un snapshot lee esa versión sin red. El contenido repetido comparte blob, no identidad de adquisición. Las lecturas
de rangos reutilizan el snapshot por ID; no tienen que descargar el artículo otra vez.

Se entregan extractores de texto y HTML. PDF se sirve mediante un extractor declarado en el entorno, cuyo contrato
devuelve texto por página y versión; el host conserva el PDF y la extracción. Si no está instalado se responde
`unsupported_media` y el agente puede buscar una versión HTML. No se presenta binario o un extracto incompleto como
documento leído íntegramente. Páginas que requieran ejecución de navegador quedan explícitamente no disponibles por
este lector; la interfaz permite añadir ese adaptador sin cambiar las citas.

La cita nueva es `src:<snapshot-id>#L<inicio>-<fin>`; los resultados de búsqueda usan
`search:<search-id>#<result-id>`. El lector mantiene las citas A6 anteriores, pero toda nueva lectura externa usa la
versión capturada. Una cita sin adquisición registrada o fuera de rango queda como referencia no verificada.
Un cambio posterior en una web no cambia el significado de una cita antigua.

El cambio de interfaz se declara como capacidad versionada en la configuración del run. Reanudar un diario A6 conserva
sus respuestas, citas y prompt anteriores; la nueva capacidad sólo entra en un run nuevo o desde la frontera registrada
de una continuación que la habilite. No se recalculan respuestas históricas con el extractor nuevo.

### 5.3 Integración con el método

Las peticiones consumen pasos como las lecturas existentes. `search` y `links` se clasifican como `recall` en
`learn/requests.ts`, la clase de `list`, `open` y `find`: leen fuentes, no el mundo, y no son experimentos sobre él.
`finish` es `exchange`. Auditoría y senior reciben el mismo vocabulario.
Las etapas documentales son trabajo legítimo: el encargo y la evidencia permiten valorarlas; no se fuerza a simular
un experimento para evitar la señal de «sólo mirar».

La guía explica las herramientas y la diferencia entre una fuente y una comprobación. Puede sugerir relacionar el
mecanismo encontrado con el problema, identificar supuestos y probar adaptaciones. No contiene nombres de técnicas que
el agente deba descubrir, listas obligatorias de analogías ni un filtro automático por distancia entre dominios.
El investigador organiza sus hallazgos en sus cuadernos y artefactos actuales.

## 6. Quién utiliza la capacidad

### 6.1 Investigador y senior

El investigador asistido puede buscar directamente cuando lo decida, también antes de atascarse. El senior dispone
del mismo servicio de fuentes durante sus turnos; su despacho deja de limitarse a memoria y ramas. Los lectores se
configuran por actor, pero comparten implementación y almacenamiento de blobs.

Integrar también el bucle propio de `grid`: no anunciar fuentes o búsqueda en un mundo que luego no las despache.
Cada host declara sus herramientas efectivas. Un mundo sin ejecución de programas puede recibir hipótesis y planes,
sin fingir que puede ejecutar procedimientos arbitrarios.

### 6.2 Delegación documental o experimental

Se mantiene `delegate` como mecanismo general. Se añade `access`, opcional, a la solicitud normal:

```json
{
  "investigate": [{
    "delegate": {
      "question": "Revisa el bloqueo y busca mecanismos de otros problemas que podamos adaptar. Desarrolla las pistas que encuentres y explica cómo contrastarlas aquí.",
      "refs": ["note:estado", "model:r8"],
      "access": { "world": "none", "sources": true },
      "budget": { "rounds": 4, "tokens": 16000, "search_calls": 8, "fetch_calls": 24 }
    }
  }]
}
```

`world: "none"` abre una investigación documental: registros autorizados, fuentes, cuaderno y artefactos propios;
no arranca simuladores, no pide un baseline del mundo y no consume evaluaciones. `world: "assigned"` utiliza el montaje
que la delegación ya tenga autorizado, aislado o compartido según su contrato. No permite elegir otro mundo oculto.
Si se omite `access`, se conserva la semántica actual; las fuentes se heredan sólo si lo habilita la configuración.
Una rama documental puede desarrollar código y entregarlo, pero para ejecutarlo necesita un perfil autorizado o una
nueva delegación experimental. No puede elevar sus propios permisos.

La rama recibe un corte identificable del trabajo del solicitante y acceso a sus snapshots documentales, sin resumen
obligatorio. El coste de leer copias locales no es otra llamada web. Su resultado vuelve por el `research_result` de
la delegación, con su autor, corte, artefactos y registro; puede ser parcial o negativo. El padre decide qué adoptar.
El límite actual de concurrencia y profundidad de ramas se mantiene salvo configuración explícita del mecanismo
general; esta capacidad no abre una recursión implícita.

Una sesión documental termina voluntariamente con `{"finish": {"report": "artifact:<hash>", "state": "complete",
"refs": [], "artifacts": []}}`, que materializa el sobre de §7. Admite también `partial` y `no_result`. `finish` es
exclusivo de hosts documentales y no se combina con `investigate` o una propuesta de modelo en la misma respuesta.
El host comprueba que el informe existe, cierra recursos y registra `stoppedBy: "task_completed"`; no registra
`accepted`. `runResults` y el corpus leen ese final como lo que es: una sesión sin modelo que proponer, no un run sin
dato. `close_round` sigue cerrando sólo una ronda. Si se agota presupuesto antes de `finish`, entrega lo que
consta en el cuaderno y artefactos como parcial, sin inventar un informe ni pedir una inferencia fuera de presupuesto.

### 6.3 Operador autónomo

Extender el agente operador con una sesión de investigación y un workspace documental. Se usa el mismo ciclo del
asistido y las mismas herramientas, con un encargo y destinatarios. No necesita ser un modelo más fuerte ni tener
autoridad para detener, enfocar o dictar directivas. Esas facultades siguen siendo permisos separados.

El operador puede acompañar uno o varios runs o un proyecto. Cada activación fija los cortes visibles que lee de cada
destinatario. Un encargo puede ser buscar alternativas a un bloqueo o seguir una cuestión abierta; no necesita nombrar
una técnica. Es configurable mediante `lab agent <journal> --research <file>` y, en el planificador, el mismo objeto
con `targets` explícitos. El formato `operator-research@1` contiene:

- `id`, `task`, `targets`, modelo/conexión del operador y fichero `external_research`;
- `wake`: eventos habilitados entre `opening`, `stuck`, `message`, `branch_result`, `every_rounds`, `interval_ms`;
- `budget`: tokens, llamadas, tiempo total y máximo de activaciones; `max_messages` por destinatario;
- `concurrency`, inicialmente 1 por sesión, y `lifetime`: `targets` o `project`.

La conexión se resuelve con la configuración de agentes existente: ningún nuevo proveedor o modelo obligatorio.
Los destinatarios son IDs de runs autorizados o miembros de un proyecto; sus vistas son las del investigador. El actor
documental no recibe ficheros de operador ni métricas ocultas por el hecho de llamarse «operador».

Los números de ronda e intervalos son límites de programación, no diagnósticos. Cada condición habilitada dispara una
activación con los hechos observados; el agente puede investigar, escribir un mensaje o esperar. No se envía un
«empujón» automático por alcanzar un contador. Ningún intervalo es infinito por defecto: el presupuesto total de la
sesión es obligatorio. `stuck` reutiliza las señales existentes; no se añade otro clasificador de atasco.

**Vigilancia externa.** Una activación temporal permite consultar novedades aunque el destinatario avance. El agente
mantiene sus consultas e intereses en el cuaderno, cambia de enfoque y decide qué comunicar. El temporizador no simula
haber encontrado una novedad. Si varias activaciones coinciden mientras trabaja se agrupan en una pendiente, con los
IDs de los hechos; no se lanzan copias de la misma sesión.

Al cerrar todos los destinatarios, `lifetime: "targets"` cancela trabajo pendiente y consolida lo alcanzado.
`project` vive hasta el cierre/cancelación del proyecto o el agotamiento de su bolsa. Un resultado tardío queda en el
registro y la bandeja del proyecto; no reabre un run terminado. Se conservan heartbeat, cancelación y reconciliación
del orquestador. Un fallo de búsqueda no detiene la investigación principal.

## 7. Entrega: una contribución que se puede seguir hasta su origen

El resultado documental es un informe libre en un artefacto versionado. Su sobre de transporte `research-contribution@1`
contiene `id`, `from`, `to`, `task`, `report`, `refs`, `artifacts`, `cut` y `state` (`complete`, `partial`, `no_result`).
`report` y los artefactos se identifican por contenido; `refs` puede apuntar a fuentes, búsquedas, episodios o ramas.
No se exige una estructura de hipótesis en el contenido ni que el agente afirme novedad positiva.

Una contribución puede incluir una conexión aún sin probar, un contraejemplo, una reproducción o un procedimiento.
Debe poder distinguirse en su texto qué se leyó, qué infiere el actor y qué experimentó. Si no ha realizado una prueba,
la entrega no inventa esa evidencia. El host comprueba referencias y permisos, no la creatividad ni la verdad del texto.

- Las ramas conservan el sobre `research_result` y adjuntan esta referencia; no generan un segundo mensaje equivalente.
- Los operadores publican una `notice` del canal con `from: "agent:<id>"`, su referencia de contribución y un texto breve.
  La entrega independiente se cuenta en su cupo de mensajes; una respuesta delegada conserva la contabilidad actual.
  En la decisión existente `message`, el campo opcional `contribution` referencia el sobre registrado; `wait` sigue
  siendo una decisión válida sin envío. No se usa una segunda vía de transporte.
- Se permite un destinatario, varios o el canal global del equipo autorizado. El canal global entrega sólo a los
  miembros con acceso a todas las referencias; en otro caso el emisor debe preparar una contribución compartible.
  El sobre conserva la audiencia concreta al publicarse, para que una reanudación no cambie quién lo recibió.
- No lleva `directive: true` por defecto. El senior puede posteriormente emitir una directiva propia si está autorizado,
  conservando el vínculo con la contribución que la motivó.
- Publicación y entrega son distintas: clave única `(contribution, recipient)` y punto de entrega registrado. Duplicar
  transporte o reanudar no duplica la ayuda. El destinatario puede leer el recorrido, adoptar, cuestionar o ignorar.

Las selecciones, cambios o experimentos que el destinatario atribuya a una contribución pueden citarla con `because`.
No se obliga a rellenar una evaluación del consejo ni a probarlo. El seguimiento puede observar esas referencias y
volver a investigar cuando haya resultados. Las fuentes pasan a ser parte del acceso documental del destinatario como
snapshots autorizados; eso no le concede navegación web adicional.

## 8. Convertir un método encontrado en un procedimiento ejecutable

Leer sobre una técnica no basta si para probarla hay que añadir cada vez un algoritmo nativo al arnés. Se incorpora
un contrato general de **programa experimental**, usando almacén de artefactos, trabajos y ejecutores existentes.

### 8.1 Artefacto y ejecución

`method-program@1` es un árbol por contenido con código, punto de entrada, versión del contrato, perfil de entorno,
entradas declaradas, parámetros, semilla y formato de salida. Las citas explican su origen, pero no forman parte de
los permisos. Puede contener una adaptación, una combinación o una implementación propia. Cada edición es una versión.

Un perfil de ejecución, configurado por el laboratorio, fija intérprete y dependencias disponibles, recursos de CPU,
memoria, GPU si procede, tiempo y salidas máximas. Su identidad incluye versiones efectivas. El agente elige entre
perfiles habilitados; no instala paquetes en el host ni aporta otro ejecutable de intérprete. Falta de una dependencia
es `unavailable` con diagnóstico: puede adaptar el programa a otro perfil o entregar el trabajo como pendiente de ejecutar.

ABI inicial: el host escribe `job.json` y monta `inputs/` y la partida en sólo lectura; el proceso escribe `out/` y
`checkpoint/` dentro de su trabajo. `job.json` declara hashes, parámetros, semilla, perfil y límites. `out/result.json`
enumera formato y rutas de productos; stdout/stderr se preservan, pero nunca son el veredicto del mundo.
El host rechaza rutas externas, productos ausentes, tamaños excedidos y formatos no autorizados.

La ejecución no tiene red ni acceso a otros runs, claves o evaluación reservada. Las entradas de internet son snapshots
ya adquiridos: descargar y ejecutar son operaciones separadas. Reutilizar el aislamiento demostrado en WE2 cuando sea
aplicable; `processSandbox` por sí solo no demuestra este aislamiento. Un perfil GPU necesita una prueba propia de
accesos y límites; no hereda esa garantía por pasar la prueba CPU. Si el backend no puede cumplirla, no ejecuta programas
adquiridos. Esto no impide la investigación documental ni el uso de recetas nativas ya autorizadas.

**En la práctica, sólo Linux.** El único aislamiento demostrado (`linux-userns-landlock@1`) es de Linux: en Windows,
la máquina de desarrollo, IE5 responde siempre `unavailable` y sus pruebas de ejecución se saltan como las de WE2. Para
la GPU no existe todavía ninguna prueba de aislamiento: hasta que la haya, un perfil GPU no ejecuta programas
adquiridos, y entrenar con un programa adquirido en la máquina 2×3090 queda pendiente de ella.

El lanzamiento utiliza identidad de trabajo, reserva, latido, cancelación y cierre de los jobs existentes. Su identidad
incluye programa, entradas, partida, perfil, parámetros y semilla. Un checkpoint sólo reanuda la misma identidad;
un cambio de método o datos abre otro trabajo. Ningún producto parcial se publica como candidato terminado.

### 8.2 Encaje en cada laboratorio

| Laboratorio | Cómo utiliza el procedimiento | Qué sigue decidiendo el host |
|---|---|---|
| Artefactos | El código obtenido se incorpora mediante `change` o una rama; se ejecuta sobre cargas de exploración | Oracle, métricas, familias y confirmación |
| Leyes y modelos interpretables | Se incorporan transformaciones al código del modelo, instrumentos propios o pruebas | Interfaz, observaciones y validaciones del mundo |
| Edición de pesos | `edit.program` adapta el programa a sus entradas y productos, preservando citas | Composición, módulos permitidos, cotas y verificación |
| Entrenamiento del junior | Nueva variante `train` con receta por programa | Datos admisibles, capacidad, productos importables y evaluación externa |

La nueva receta es `method: "program"` dentro de `junior-recipe@1`, con `program`, `profile`, `inputs`, `parameters`,
`seed`, `output_kind` y los límites de la bolsa. Usa una unión discriminada; los campos exclusivos de LoRA no se exigen
a esta variante. La autorización del manifiesto enumera perfiles, datos, módulos y formatos, no nombres de algoritmos.

Productos iniciales admitidos: adaptador LoRA del formato ya soportado, un conjunto de cambios de pesos equivalente a
`weight-edit-set@1`, o una máscara `mask@1` (SPEC-EDICION-PESOS §15.3). No se cargan objetos Python arbitrarios ni
formatos que el importador no pueda verificar.

**Cómo se sabe qué aprendió un paquete.** Hoy la confirmación lo deduce del formato: un `edit-set:` en la procedencia es
una edición y nunca un entrenamiento (`owes` en `junior/confirm.ts`). Un programa que aprende de datos y emite cambios
`−W` rompe esa deducción. La procedencia del paquete gana un campo explícito, `learned`: `trained` (de datos, con su
dataset o sus trayectorias), `edited` (escrito o construido, sin entrenamiento) o ninguno. Lo escribe el host al importar
el producto, nunca el programa, y `owes` lo lee antes que el formato; los paquetes anteriores, sin el campo, se siguen
leyendo como hasta ahora.

**Con §15 de SPEC-EDICION-PESOS, una sola forma.** `deletion@1` se implementa como el primer `method: "program"`: un
programa del perfil de entrenamiento que aprende la máscara y emite `mask@1`, con `learned: "trained"`. Así el
aprendizaje de qué borrar no añade un tipo de trabajador propio, y lo que §15 exige (cotas, capas del circuito,
realizaciones, partición `training`) es lo que el importador comprueba aquí.

El host aplica las mismas prohibiciones de combinación de adaptadores, módulos del circuito y cotas que correspondan
al producto. Comprueba tensor por tensor o por los factores del formato qué se puede modificar. Valida datos y
`provenance.realizations` antes de lanzar; el código no puede declarar una procedencia vacía para eludirla. Para una
receta de entrenamiento sólo se montan datos autorizados para entrenamiento. Sondas de selección, holdout y confirmación
no entran en sus archivos ni en su recompensa. La promoción considera el linaje completo de búsqueda/adaptación.

La prueba de capacidad ejecuta el mismo programa y perfil con una entrada acotada y cuenta su gasto. El host impone
también límites durante la ejecución completa: la estimación del propio programa no garantiza cabida. El investigador
puede observar errores y revisar su implementación, como cualquier artefacto.

Se conservan programa, perfil, entradas, trazas, checkpoints y productos. Replay consume lo registrado sin volver a
entrenar. Reejecutar el programa es otra operación: registra diferencias numéricas o no determinismo, sin prometer
identidad bit a bit de entrenamientos GPU. Un procedimiento no necesita entrar en el código del arnés para reutilizarse:
se referencia como otro artefacto por hash, también desde el catálogo de metapolíticas.

## 9. Coste, registro y reproducción

### 9.1 Bolsas

Tokens del actor, búsquedas, descargas, bytes y ejecución de experimentos tienen unidades separadas. La búsqueda directa
gasta la bolsa de fuentes del run; una rama reserva del fondo que la lanza; un operador autónomo usa su fondo propio.
Todos contribuyen al total del proyecto una sola vez. El host reserva antes de actuar, liquida con el resultado y
conserva gasto incierto ante caídas. No hay multiplicación de saldo por abrir ramas o por varios destinatarios.
Cada fondo tiene un único propietario que serializa reservas; los hijos reciben concesiones, no copias editables del
saldo. Una descarga reserva hasta el menor de su límite por documento y el saldo disponible; la lectura se corta al
alcanzarlo, con resultado incompleto explícito, y se libera lo que no consumió.

Cada intento HTTP enviado consume una unidad de su bolsa, incluso si falla; una negativa local no la consume.
Los bytes cuentan lo recibido, también de respuestas interrumpidas, hasta el límite autorizado. Los reintentos de
errores transitorios se limitan a dos, con espera y respeto a `Retry-After` dentro del tiempo restante; se registran
por separado. Autenticación inválida detiene esa capacidad y se comunica al actor. Una consulta fallida no es una
refutación de la hipótesis ni «no hay literatura».

Al agotarse la bolsa se informa del límite. El actor puede continuar con sus datos, leer snapshots adquiridos,
terminar o entregar un resultado parcial. Las publicaciones y entregas de un resultado ya escrito no requieren otra
llamada al LLM. La consolidación usa la reserva prevista por la delegación o la sesión del operador.

### 9.2 Registro único y exportación

Extender el diario y replay existentes: no crear una base de datos alternativa que decida qué ocurrió. Eventos nuevos
tipados para búsqueda solicitada/terminada/fallida, snapshot adquirido, activación del operador y contribución publicada.
Los trabajos y entregas reutilizan sus eventos actuales. Conservar también las búsquedas infructuosas, lecturas
descartadas, programas fallidos y revisiones; no sólo el informe final.

La clave de una operación incluye actor, posición en la secuencia y petición canónica. Repetir la misma consulta más
tarde puede observar una web distinta; reanudar la misma operación usa su respuesta grabada. Una llamada cuyo resultado
se perdió se reconcilia como incierta; un nuevo intento es visible y tiene su propio coste.

El paquete exportado incluye el árbol de ramas, contribuciones y todos los snapshots, programas y entradas que se
consultaron o ejecutaron. Los cuerpos y extractos se conservan por contenido, sin credenciales. Las dependencias se
recorren desde el registro de operaciones, no sólo desde las citas elegidas al terminar.

Replay offline debe reconstruir respuestas y puntos de entrega sin buscador, red, inferencia ni ejecución experimental.
Un snapshot necesario que falte es un error de integridad; no se vuelve a descargar en silencio. Al continuar tras la
historia grabada vuelven a permitirse nuevas observaciones bajo la configuración vigente.

## 10. Observabilidad y criterio de utilidad

La consola muestra las activaciones del operador, ramas documentales, búsquedas y documentos abiertos, contribuciones
enviadas/recibidas y versiones o experimentos que las citan. Permite navegar del experimento al mensaje, de éste al
informe y de éste a las fuentes exactas. No exige una nueva vista paralela: ampliar timeline, detalles y costes actuales.

El finding distingue: acceso externo habilitado (y si fue `allowlist` o `public`), usado, negado por el mundo,
aportaciones recibidas y métodos/artefactos adoptados cuando hay referencias explícitas. No atribuye causalidad sólo porque una lectura preceda a una mejora. La auditoría puede
interpretar el recorrido con citas; el host no asigna automáticamente puntuación de creatividad ni éxito a una búsqueda.

La comprobación práctica es que el sistema encuentre y desarrolle una dirección pertinente sin que el operador nombre
esa técnica. No hace falta demostrar superioridad estadística para que la capacidad sea útil. Sí hace falta distinguir
un consejo, un procedimiento ejecutado y una mejora que haya pasado las evaluaciones del mundo.

Piloto de extremo a extremo: un problema existente de artefactos o adaptación del junior, con su evaluador fijo; encargo
formulado por problema y restricciones, sin nombres de técnicas ni enlaces preparados para la solución. El operador
autónomo inspecciona el run, descubre fuentes, desarrolla una alternativa y entrega un experimento o artefacto trazable.
El investigador decide qué hacer. El informe conserva si abrió otra dirección, si se ejecutó y qué respondió el mundo.
No encontrar una dirección útil es resultado del piloto, no motivo para cambiar retrospectivamente el encargo.

**Comparación opcional.** La capacidad tiene coste (búsquedas de pago, descargas, tokens). Para saber si compensa en el
pipeline, el operador puede lanzar una comparación pareada con y sin acceso externo, con las herramientas de diseño que
ya existen: las mismas semillas, un margen declarado antes y `pairedComparison`. No es condición para entregar la
capacidad, pero sí para decidir usarla por defecto en una campaña.

## 11. Entregas de implementación

| Entrega | Trabajo y módulos | Aceptación |
|---|---|---|
| **IE1 · Fuentes descubribles** | Extender `sources.ts`; nuevo `learn/assisted/source-search.ts` y adaptador HTTP; snapshots con blobs, citas y enlaces; configuración CLI | Búsqueda real configurable y proveedor simulado; errores diferenciados; lectura versionada; replay sin red |
| **IE2 · Herramientas compartidas** | `session.ts`, `agent-operator.ts`, bucle `grid`, `learn/requests.ts`, presupuesto y capacidades | Junior sin senior y senior buscan por sí mismos; puro y runs sin capacidad conservan su comportamiento |
| **IE3 · Ramas documentales** | `delegation.ts`, lanzamiento/control, sesión común sin hooks de mundo; herencia de permisos y reservas. **Después de CC3** de SPEC-CONSOLIDACION: la sesión y `runLawLab` están hoy atados al mundo, y separar sus hooks es partir el runner | Investigar fuentes no arranca una simulación; entrega y reanudación sin duplicados; puede producir artefactos |
| **IE4 · Operador investigador** | `agent-operator.ts`, planificador, activaciones persistidas, contribuciones y canal | Busca por atasco, encargo o reloj; funciona con varios destinatarios; no obliga a obedecer; cierre y coste completos |
| **IE5 · Procedimientos adquiridos** | Artefactos; `weights.ts`, `isolation.ts`, `train.ts` y trabajadores; perfil, ABI, importador y procedencia (`learned`); `deletion@1` como primer programa. Sólo Linux; GPU pendiente de su prueba de aislamiento | Un algoritmo escrito como programa produce un candidato sin registrar una técnica nativa; mismo evaluador; aislamiento y límites comprobados |
| **IE6 · Recorrido completo** | `runtime/package.ts`, replay, consola, findings, ejemplos y piloto | Del bloqueo a fuente, contribución y experimento; paquete reproducible offline; gasto y limitaciones visibles |

Orden: IE1 → IE2 → IE4; IE3 tras CC3; IE5 puede desarrollarse tras IE2 reutilizando IE1 para entradas. IE6 integra
todas.
Cada entrega actualiza esta cabecera y declara qué funciona realmente. IE1–IE4 ya aportan búsqueda e inspiración con
las herramientas actuales; **el objetivo completo incluye IE5**, para no conservar como cuello de botella la necesidad
de que el humano implemente cada método encontrado. No se exige que todos los entornos dispongan de GPU o PDF.

Archivos de ejemplo a entregar: `lib/examples/external-research.json`, `operator-research.json` y
`external-research.md`, con configuración, lanzamiento, continuación, exportación y lectura del recorrido. Secretos
sólo por entorno. Incluir un ejemplo de procedimiento pequeño que se ejecute con backend simulado/CPU y uno compatible
con el laboratorio del junior; declarar las dependencias de este último antes de reservar recursos.

## 12. Pruebas de aceptación

1. Sin `web.access`, el acceso es `allowlist`: una consulta descubre una URL fuera de la lista y abrirla responde
   `not_allowed` con su dominio; activado `public` expresamente, la misma URL se abre. Redirecciones y destinos no
   públicos respetan el mismo límite.
2. Buscar cero resultados, fallar el proveedor, agotar saldo y recibir contenido no soportado producen estados distintos.
   Un texto que ordene cambiar permisos o evaluador se conserva como fuente y no ejecuta esas instrucciones.
3. Una página cambia tras leerse: su cita anterior sigue resolviendo al mismo texto. `links` usa la URL final y los
   enlaces capturados. La URL y el snapshot distinguen nueva observación de lectura de una versión.
4. Junior, senior y rama resuelven las mismas herramientas con sus permisos efectivos; una rama no amplía orígenes o
   presupuesto. Cubrir los bucles común y `grid`, y la ausencia de cambios en el investigador puro.
5. Una rama `world: "none"` termina con un informe y artefactos sin baseline, simulador o modelo ficticio; el destinatario
   recibe una sola contribución, puede ignorarla y puede abrir su recorrido completo.
6. Un operador se activa por reloj sin atasco, encuentra una pista y decide comunicarla; otro caso devuelve `wait`.
   Activaciones coincidentes y reinicios no duplican sesiones. Un destinatario cerrado no se reabre por un mensaje.
7. Entrega individual y global conservan audiencia, referencias y punto de recepción. Una referencia privada impide
   compartir el sobre con un destinatario no autorizado. Una aportación no cambia `holds` ni se vuelve directiva.
8. Dos actores concurrentes no gastan la misma reserva. Caída entre envío y respuesta deja gasto incierto; el reintento
   se registra. Coste agregado y compartido no duplican llamadas ni multiplican bolsas.
9. Un procedimiento escrito por el investigador, no nombrado en una enumeración de métodos, se versiona, ejecuta e
   importa como candidato. Una edición del procedimiento cambia identidad; un checkpoint ajeno no se reanuda.
10. El programa sólo lee entradas concedidas y la partida; no alcanza red, host, otros runs o datos reservados. El
    importador rechaza cambios del circuito, salidas fuera de cota o procedencia incompleta. El backend que no demuestra
    las condiciones declara la capacidad no disponible, también en GPU.
11. Un programa devuelve «éxito» pero su producto es malo: el evaluador fijo lo rechaza. Otro aprende de datos permitidos
    y produce un formato de edición: conserva procedencia de entrenamiento y se comprueba contra las particiones.
12. Exportar, desconectar todos los servicios y reproducir conserva el recorrido, los textos y las entregas. Borrar un
    blob requerido provoca un error explícito. Ninguna prueba offline hace inferencia ni paga búsquedas.
13. En un mundo que declara `externalSources.admitted: false`, ni la lista blanca ni `public` llegan a su investigador,
    su senior ni sus ramas: las herramientas no se anuncian y, pedidas, responden `not_allowed` con el motivo del mundo;
    una contribución que cita fuentes externas no se le entrega. La experiencia de otros runs, su registro, su memoria y
    los resultados de sus ramas siguen disponibles. Una prueba recorre todos los laboratorios y lista su declaración.
14. `search` y `links` son `recall` para la auditoría y el senior, como `list`, `open` y `find`.
15. Dos ensayos del metalaboratorio que sólo difieren en su configuración `external-research@1` tienen ids distintos.
16. Un programa que aprende de datos y emite cambios `−W` produce un paquete con `learned: "trained"`; la confirmación lo
    lee como entrenado aunque su formato sea un conjunto de ediciones, y exige sus realizaciones.

## 13. Revisión (13/11/2026)

Revisada contra el código y las reglas del proyecto antes de entregarla:

| Punto | Decisión |
|---|---|
| El acceso por defecto era `public` | La lista blanca del operador es el defecto (la regla de A6); `public` sólo se activa expresamente (decisión del usuario, 13/11/2026) |
| Mundos cuya respuesta está publicada | Un mundo puede negarse a las fuentes externas (lista blanca y web pública) y se respeta; la metainvestigación no la puede bloquear (decisión del usuario, 13/11/2026). `c302nav` y `c302closed` lo declaran (§4.1) |
| `search` y `links` eran «observación documental» | Son `recall`, la clase de las demás lecturas de fuentes en `learn/requests.ts` (§5.3) |
| La configuración externa no entraba en la identidad de un ensayo | Entra, con la declaración del mundo (§4.2) |
| «`trained` no se deduce del formato», pero la confirmación lo deduce | Campo explícito `learned` en la procedencia, escrito por el host y leído por `owes` (§8.2) |
| §8.2 y SPEC-EDICION-PESOS §15 daban dos formas a aprender qué borrar | Una: `deletion@1` es el primer `method: "program"` y emite `mask@1` (§8.2) |
| IE3 suponía una composición barata de la sesión sin mundo | Depende de CC3 (partir el runner) |
| IE5 y el aislamiento | Sólo Linux; GPU pendiente de una prueba de aislamiento propia (§8.1) |
| `stoppedBy: "task_completed"` sin lectura | `runResults` y el corpus lo leen como sesión sin modelo (§6.2) |
| La utilidad no se medía | Comparación pareada opcional con y sin acceso externo, antes de usarlo por defecto en una campaña (§10) |

Las pruebas automáticas usan respuestas y transportes simulados y ejecutores controlados. El piloto real comprueba la
utilidad y la integración con el proveedor; no se ejecuta como parte de la suite ni consume presupuesto sin configurar.
