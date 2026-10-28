# SPEC · Aprender una metapolítica de investigación

Estado (28/10/2026): **M1 y M2 implementados (§13.1, §13.2); M3 preparado y sin lanzar (§13.3)**.

Se apoya en el [investigador asistido](SPEC-INVESTIGADOR-ASISTIDO.md), el [senior](SPEC-ORQUESTADOR.md),
el [canal de mensajes](SPEC-CANAL-MENSAJES.md), el [mundo de artefactos](SPEC-MUNDO-ARTEFACTOS.md) y la
[delegación evolutiva](SPEC-DELEGACION-EVOLUTIVA.md). La [delegación de investigaciones](SPEC-DELEGACION-INVESTIGACIONES.md)
sigue siendo el mecanismo para encargar trabajo a otro investigador. No se recupera `what_if` ni se depende de su
implementación retirada; no hay compatibilidad ni migración que construir para aquella herramienta.

## 1. Qué queremos obtener

**Un procedimiento legible y ejecutable que aprenda a orientar a un investigador pequeño a partir de su recorrido.**
Queremos convertir parte de la experiencia estratégica que hoy aporta el senior en un artefacto reutilizable:
reconocer qué impide avanzar y proponer qué tipo de trabajo conviene hacer a continuación.

El modelo pequeño mantiene sus pesos. Aprende el sistema investigador al incorporar un procedimiento contrastado.
La generación de hipótesis concretas, el diseño del experimento y la decisión de ejecutarlo siguen siendo trabajo de
System 2. No se presupone que una política sustituya la creatividad o el conocimiento de un senior más capaz.

La pregunta de investigación es: **¿qué puede resolver ahora ese mismo investigador, y qué errores sabe superar,
cuando dispone de una orientación estratégica aprendida?** La legibilidad del procedimiento y la reconstrucción de
su aprendizaje son parte del producto. El coste delimita su uso; no sustituye la capacidad como objetivo.

Dos niveles usan el mismo arnés:

| Nivel | Objeto de investigación | Experimento | Producto |
|---|---|---|---|
| Exterior | El procedimiento del investigador | Probar una versión en runs interiores | Una metapolítica y su evidencia |
| Interior | El mundo asignado | Actuar, medir, contrastar y revisar | El modelo o artefacto habitual de ese mundo |

El investigador exterior puede ser pequeño o potente; no tiene que estar presente cuando se utiliza la política.
Se pueden comparar distintas políticas para el mismo junior y estudiar después su transferencia a otros modelos.

## 2. Alcance de la primera entrega

La política recomienda una de tres orientaciones, o se abstiene:

| Orientación | Trabajo sugerido; no una fase obligatoria |
|---|---|
| `develop` | Desarrollar una línea que sigue aclarando el problema: medir, ajustar, construir un instrumento o comprobar una predicción. |
| `contrast` | Buscar una observación que distinga alternativas, revisar un contraejemplo, replicar o comprobar el instrumento. |
| `reframe` | Revisar un supuesto o representación, recuperar una alternativa o encargar una exploración independiente. |

Estas etiquetas describen la orientación, no demuestran que sea correcta. No obligan a recorrer un ciclo ni fijan
cuántas rondas dedicar a una idea. No mejorar el resultado puede ser progreso si se descartan alternativas. Repetir
puede ser una réplica necesaria. La confianza declarada por el junior y los juicios de Jev no son medidas de la
incertidumbre real del mundo.

Se aprende **cuándo intervenir y con qué orientación**, incluyendo cuándo guardar silencio. La primera entrega no
modifica pesos, herramientas, permisos, veredictos ni presupuestos del junior, ni permite que la política ejecute
experimentos, cierre rondas, descarte creencias o lance ramas por su cuenta.

Una recomendación puede sugerir usar `delegate`, pruebas propias, instrumentos o pedir ayuda si están disponibles.
La petición concreta sigue el protocolo existente y consume sus recursos normales. No se necesita otro generador
de hipótesis ni un nuevo tipo de investigador para esta entrega.

## 3. Artefacto que se aprende

Formato propuesto: `research-policy@1`. Se conserva por contenido, con padres y motivo de cada cambio, usando el
almacenamiento de artefactos existente. Incluye:

- Observaciones en código sobre una vista autorizada del recorrido.
- Reglas semánticas opcionales, con preguntas y criterios completos, evaluadas por el `Judge` existente.
- Composición en código y estado inicial JSON: decide si intervenir, qué orientación recomendar y qué plantilla usar.
- Plantillas legibles de orientación, argumentos permitidos y referencias a las observaciones que las sustentan.
- Versiones del contrato de entrada, capacidades requeridas y procedencia de la experiencia utilizada.

El código se ejecuta en el sandbox de funciones con límites de ejecución y tamaño. No dispone de archivos, red,
reloj de pared, generadores aleatorios implícitos ni herramientas del mundo. El host efectúa las llamadas al Judge
por los clientes y el registro del arnés. No se añade un cliente LLM privado a la política.

Los hechos calculables se calculan; los juicios semánticos quedan identificados como juicios. Por ejemplo, el número
de actos rechazados es un hecho del diario; que dos creencias representen mecanismos distintos requiere interpretación.
Las preguntas independientes pueden agruparse. El Judge devuelve decisiones tipadas; el texto del consejo se monta
con las plantillas versionadas y valores autorizados, sin otra generación libre en tiempo de uso.

Se admite una política sólo de código. Una que requiere Jev no se convierte silenciosamente a código cuando falta
el servicio: se rechaza al configurar el run; un fallo transitorio se registra como fallo de evaluación.
Los umbrales, preguntas, observaciones, plantillas y composición pueden evolucionar. Cambiar el modelo del Judge
es cambiar la condición de investigación, no una mutación inadvertida del procedimiento.

Contrato conceptual de salida, validado por el host:

```ts
type Guidance =
  | { kind: 'abstain'; reason: string }
  | {
      kind: 'advise';
      focus: 'develop' | 'contrast' | 'reframe';
      template: string;
      arguments: Record<string, string | number | boolean>;
      evidence: string[]; // IDs presentes en la entrada autorizada
      judgments: string[]; // Reglas utilizadas, no evidencia del mundo
    };

type PolicyResult = { guidance: Guidance; state: unknown };
```

El estado privado de la política sólo conserva información derivada de sus entradas y decisiones. Está acotado,
se registra y se reinicia en cada ensayo independiente. No puede transmitir resultados entre ensayos ocultos.
El hash identifica el contenido ejecutable completo; las rutas y fechas de ejecución no forman parte de él.

Ejemplo de orientación: «Las explicaciones referenciadas siguen abiertas y los experimentos recientes no las
distinguen; busca una intervención y escribe qué esperarías bajo cada una antes de ejecutarla». La política conserva
las referencias leídas y el juicio que motivó el consejo. Ese diagnóstico es una hipótesis sobre el método: puede
estar equivocado y el junior puede señalar un contraste que la captura no incluía.

Las plantillas no se usan para introducir soluciones de los mundos de experiencia como si fueran método general.
Si una candidata incorpora conocimiento de dominio, se declara en su procedencia y se evalúa como política informada
o especializada. La inspección del artefacto y la prueba en dominios reservados sirven para distinguirlo; comprobar
la sintaxis del contrato no acredita por sí solo transferencia de método.

## 4. Qué puede observar

La entrada es una captura de la vista del junior **hasta un corte concreto del diario**, nunca el diario bruto del
operador. Se construye desde los adaptadores de memoria y registro, con una lista explícita de campos permitidos:

- Creencias, revisiones, notas y métodos que el junior escribió; referencias a sus modelos y artefactos.
- Peticiones y respuestas visibles: se conserva si un experimento se ejecutó, fue rechazado o quedó sin resultado.
- Veredictos y contraejemplos ya comunicados, sin medidas reservadas ni la verdad oculta.
- Ayuda efectivamente entregada, orientaciones anteriores y lo que el junior haya escrito sobre ellas.
- Capacidades y recursos restantes que el junior conoce, más los límites propios de la política.

El perfil de contexto fija ventanas, selección determinista y límites antes de comparar políticas. Debe incluir
contenido y resultados, no sólo contadores. Registra omisiones y truncamientos; ausencia de una cita en una ventana
no demuestra que el investigador nunca hiciera ese experimento. Las funciones de observación pueden seleccionar
y calcular sobre esa entrada, pero no ampliar sus permisos.

`stuckSignals` aporta hechos reutilizables tras aplicar esta frontera. No se heredan automáticamente sus umbrales ni
sus interpretaciones. El recorrido completo sigue disponible para el junior mediante sus herramientas.

La política no lee eventos posteriores al corte, resultados aún no entregados, el cuaderno privado del senior,
auditorías posteriores, ni criterios o ejemplos reservados de confirmación. Las referencias de su respuesta deben
existir en la captura; las inválidas hacen inválida la salida, no se inventa evidencia para completarla.

## 5. Cuándo actúa y cómo llega al junior

Configuración propuesta `research_policy`, desactivada por defecto, sólo para el investigador asistido. Identifica
el artefacto, perfil de contexto, Judge cuando proceda y límites de evaluaciones, inferencia, estado y mensajes.
No cambia el investigador puro ni las conversaciones de runs donde no esté habilitada.

El punto de integración está **antes de la siguiente pregunta al junior**, después de resolver las herramientas y
recibir los eventos que le corresponden. Se toma el corte antes de añadir la orientación. Se evalúa como máximo una
vez por corte nuevo; publicar su propio mensaje no crea otra oportunidad. La política puede abstenerse o conservar
en su estado una separación entre intervenciones. El host no interpreta un contador como estancamiento obligatorio.

Secuencia de cada decisión:

1. Comprobar que el run puede continuar y reservar recursos; fijar ID, captura y hash de política.
2. Calcular observaciones, obtener los juicios necesarios y ejecutar la composición.
3. Validar resultado y estado; guardar entradas, juicios, decisión y recibos antes de publicar.
4. Si aconseja, entregar un `notice` por el canal existente con autor `agent:research-policy`, versión, foco,
   referencias y texto. La entrega tiene identidad única y se vincula a la pregunta que lo recibió.

La orientación es consejo, nunca `directive: true`. No queda fijada como orden pendiente ni bloquea una propuesta
si el junior no la sigue. Puede aceptarla, adaptarla o rechazarla en sus notas sin un formulario obligatorio nuevo.
La ausencia de una reacción explícita se informa como desconocida; no como adopción o desobediencia.

Se distinguen `abstain` válido, falta de contexto, fallo del Judge, salida inválida y límite agotado. Ninguno de los
cuatro últimos se registra como una recomendación de continuar. El junior puede seguir con sus herramientas.
Un fallo definitivo se conserva para la evaluación de la política aunque el investigador consiga terminar.

Si la captura queda superada por nueva información del mundo o del junior durante una evaluación asíncrona,
el resultado se marca obsoleto y no se entrega como orientación actual. Una evaluación posterior consume recursos
propios; no hay reintento ilimitado ni se congela un mundo vivo para consultar a la política.

## 6. Relación con el senior y el operador

La sustitución inicial se prueba dejando el senior deshabilitado y usando la política como orientación estratégica.
El senior actual permanece disponible como condición de referencia. No se cambia su contrato de directivas.

El modo conjunto es válido y se identifica como otra condición: ambos leen sólo lo autorizado, el senior ve las
orientaciones ya entregadas y la política ve los mensajes públicos del senior que haya recibido el junior. Cada
aportación conserva autoría. La política no cancela directivas ni modifica permisos del operador. Ordenar entregas
de forma determinista no equivale a resolver el desacuerdo entre sus contenidos.

La política puede recomendar solicitar ayuda; no activa por detrás un modelo más potente. Una ejecución con senior,
delegación o intervención humana adicional se identifica y contabiliza como tal. No acredita por sí sola sustitución.

## 7. Aprender con los runs que ya tenemos

Los registros anteriores son un corpus de experiencia, de ejemplos de funcionamiento y de fallos. No son etiquetas
de la decisión correcta ni experimentos contrafactuales. Que una intervención del senior preceda a una mejora no
demuestra qué parte de aquella intervención la causó.

Primero se construye un índice, sin cambiar los originales. Por registro conserva hash, mundo y versión, realización,
modelo y razonamiento, herramientas, senior y ayudas, presupuesto, procedencia, continuación y resultados disponibles.
Se marca si tiene material suficiente para lectura, reconstrucción o reejecución; no se exige que los diarios más
antiguos tengan capacidades que aún no existían.

Hay material local identificado en los siguientes lugares; son puntos de partida, no una partición ya validada:

| Mundo | Ejemplo de registro o lote existente | Pregunta que permite explorar |
|---|---|---|
| Grid | `runs/grid-s22-2026-10-01T08-55-27-725Z.json` y otros `grid-s22-*` | Cambios de hipótesis, intervenciones del senior y revisión del modelo. |
| Orbit | `runs/orbit-s3L1-2026-09-26T11-24-41-588Z.json` y continuaciones de la investigación | Ajuste de parámetros, límites de una explicación y contraste por intervenciones. |
| Cells | `runs/cells-s1L3-2026-09-27T16-18-06-169Z.json` y niveles anteriores | Representaciones y uso de historial. |
| Blender | `runs/particles3d-s1L1C-2026-09-30T09-50-07-850Z.json` y sus continuaciones | Experimentación con dinámica y errores de predicción. |
| c302 | `runs/batches/c302nav-senior-3/`, `runs/batches/c302closed-n2-2/` y otros lotes | Interacción senior–junior, regresiones y transferencia entre evaluaciones. |
| Artefactos | `runs/batches/artifacts-threesum-stall/`, sus continuaciones y `artifacts-dedup-pilot/` | Optimización local, nuevas direcciones y adopción de resultados delegados. |

El investigador exterior accede mediante experiencia `meta`, con referencias documentales. No se obliga a resumir
cada run ni se le entrega un fichero bruto con medidas ocultas. El lector actual de experiencia no expone por defecto
los mensajes del operador: para estudiar orientación hay que añadir una proyección explícita de **lo entregado al
junior**, con autor, corte y respuesta, o declarar que ese registro no ofrece esa información. No se expone el diario
privado entero del senior como atajo.

La auditoría de método existente conserva su condición de lectura del operador. Sus calificaciones posteriores no
se introducen en la política ni se convierten en etiquetas de entrenamiento. El investigador exterior puede realizar
sus propios análisis sobre los registros autorizados y contrastarlos mediante nuevas ejecuciones.

Cada linaje —original, continuaciones, ramas, semillas y experiencia derivada— se identifica junto. No se reparten
sus fragmentos entre experiencia y evaluación como si fueran investigaciones independientes. Para afirmar transferencia
entre dominios se reserva además algún tipo de mundo completo fuera del desarrollo; para una política especializada
bastan nuevas realizaciones del ámbito declarado, sin llamarlo transferencia entre dominios.

## 8. El laboratorio de metainvestigación

Se añade un adaptador de tarea para investigar políticas versionadas. Reutiliza almacenamiento y cambios de artefactos,
el investigador, los lanzadores de runs y la interfaz `Evaluator` del motor evolutivo. Su ejecución primitiva es un
**ensayo de investigación**, no un benchmark de tiempo de una función ni una llamada que puntúa la prosa de la política.

Un ensayo fija antes de empezar: política, configuración del junior, mundo y realización, herramientas, experiencia
permitida, otras ayudas, límites, versiones y criterio de resultado del mundo. Arranca un run con estado de política
vacío y conserva diario, respuestas, modelos, artefactos y veredicto. Los ensayos no leen sus hermanos.

El investigador exterior puede cambiar observaciones, preguntas, composición y orientaciones; probar la variante;
leer lo ocurrido; conservarla, repararla o volver atrás. Puede delegar su desarrollo o usar búsqueda evolutiva.
En todos los casos se evalúa el mismo contenido y se conserva su linaje. La política queda congelada durante cada
run interior. Cambiarla a mitad de ese run es otra condición adaptativa, fuera de la comparación inicial.

El adaptador lanza trabajos del host registrados, con un identificador antes de despacharlos. El código de la política
no recibe privilegios de lanzamiento. Una caída se reconcilia con el estado del hijo: no vuelve a empezar un ensayo
ya terminado ni paga otra inferencia al verificarlo. La cancelación alcanza los hijos y conserva parciales.

No se convierte `wall_ms` en utilidad ni se fuerza el juicio de ratios de rendimiento de `ArtifactTask` sobre tasas
de éxito. El nuevo evaluador traduce los resultados de investigación al contrato del motor. El mundo interior mantiene
sus propias evaluaciones y el mundo exterior mantiene su partición de desarrollo y confirmación.

## 9. Evaluador fijo y selección

El manifiesto del laboratorio exterior fija casos, particiones, criterio de resultado y recursos. Sólo el operador
puede cambiarlo creando otra condición. Ni la política ni el investigador exterior editan el evaluador, sus datos
reservados o la definición de aceptación de los mundos interiores.

Para la primera entrega:

- La corrección del candidato significa que cumple el contrato ejecutable, la frontera de información y sus límites.
  Una política válida que no ayuda sigue siendo una candidata desarrollable. Un error propio de la política no se
  borra porque el junior termine sin ella; un fallo de infraestructura queda separado y sin medida inventada.
- La calidad de selección tiene un componente por tipo de mundo: `q = 1 - fracción de ensayos que resuelven su tarea`.
  Cada tipo pesa por sus ensayos, no por el número de puntos o ventanas que produzca. En artefactos se fija el producto
  como objetivo si ése es el encargo; acertar el modelo de rendimiento no equivale a mejorar el producto.
- Esta calidad encaja con el comparador existente, que ordena componentes del peor al mejor. Es una preferencia de
  selección explícita por robustez entre mundos, no una prueba estadística. Se conserva también el vector con sus nombres.
- Cobertura de checks, contraejemplos resueltos, giros útiles y costes son diagnósticos separados. No se mezclan con una
  nota de estilo ni se añaden como componentes heterogéneos al comparador. Una tarea dirigida a progreso parcial puede
  definir otro criterio objetivo antes de buscar, con nueva identidad; no se cambia tras ver qué candidata gana.

El manifiesto separa **experiencia histórica**, **casos de desarrollo** y **confirmación**. Los runs de desarrollo y
sus resultados pueden guiar la búsqueda; se refrescan según un calendario fijado. Una candidata final congelada se
contrasta en realizaciones reservadas. Si se desarrolla a partir de ese resultado, esos casos pasan a desarrollo y
se necesita nueva confirmación para la siguiente afirmación de transferencia.

Se comparan resultados por ensayo y mundo, con repeticiones e incertidumbre declaradas. No se computan miles de filas
de un mismo run como miles de éxitos independientes. Una mejora confirmada significa superar el criterio y márgenes
del manifiesto frente a la referencia, incluidas las tolerancias de regresión por mundo. Poca evidencia se informa
como indicio o resultado inconcluso; no impide entregar una política inspeccionable y los caminos que abrió.

## 10. Cómo se comparan las condiciones

| Condición | Qué permite saber |
|---|---|
| Junior actual, sin política ni senior | Referencia del investigador pequeño. |
| Junior con recordatorio genérico fijo | Si basta un recordatorio de contrastar y revisar alternativas. |
| Junior con política candidata | Si el diagnóstico situado añade capacidad. |
| Junior con senior actual | Cuánto de su orientación y capacidad total consigue sustituir. |
| Junior con política y senior | Complementariedad, cuando interese estudiarla; nunca se mezcla con sustitución. |

El recordatorio tiene texto y calendario fijados antes de probar candidatas; no se adapta después para favorecer una
comparación. Se registran número y longitud de los consejos. El junior conserva modelo, razonamiento, herramientas y
condición inicial. Se declaran los límites totales de trabajo y los de ayuda; inferencia de la política, senior y ramas
cuenta dentro del total de cada condición. No se presenta como ventaja del método una comparación con ayuda oculta.

Los runs históricos sirven como referencia descriptiva y, cuando las condiciones coinciden y los registros lo
permiten, como ejecuciones de referencia reutilizables. El índice explicita diferencias de versión, modelo, tarea y
presupuesto; no se necesita repetir todo el corpus ni fingir que sus resultados son directamente comparables.

Evaluar una política sobre prefijos históricos sin entregar sus consejos sirve para inspeccionar sus decisiones.
**No mide qué habría sucedido al seguirlas.** Para medir consecuencias se hacen nuevos runs completos. Un experimento
desde un corte sólo es válido si el adaptador puede reconstruir todo el estado necesario y declarar el nuevo linaje;
no se presupone esa capacidad para todos los mundos ni se llama replay a una trayectoria con decisiones nuevas.

## 11. Presupuesto, registro y reproducción

Se distinguen recursos de aprendizaje exterior y recursos de uso interior. El coste de aprender una política queda
en su procedencia; su evaluación durante un run pertenece a ese run. No se vuelve a cobrar el aprendizaje cada vez
que se usa, ni se oculta al comparar el trabajo total de descubrirla.

Cada consejo automático es ayuda del lado del operador: consume una entrega del presupuesto de ayuda al publicarse,
una sola vez. Abstenerse no consume ayuda. Evaluaciones y llamadas fallidas consumen sus recursos observados;
usage ausente sigue siendo desconocido. Si no quedan recursos para aconsejar, no se sigue haciendo inferencia inútil.
El presupuesto exterior reserva antes del lanzamiento el trabajo interior, incluyendo llamadas a Jev y ramas.
No hay delegación recursiva gratuita ni multiplicación implícita del fondo.

Eventos propuestos, con nombres sujetos a la convención del módulo, pero con estos contratos:

- `research_policy_requested`: ID de decisión, hash de artefacto, corte, captura recuperable, estado anterior y reserva.
- `research_policy_decided`: observaciones, preguntas, respuestas y consumo; salida validada, nuevo estado o fallo.
- `research_policy_delivered`: ID de mensaje y pregunta receptora; o motivo de no entrega, incluida obsolescencia.
- `research_trial_requested` / `research_trial_finished`: identidad del ensayo, hijo, configuración, estado y resultado.

Se registran también abstenciones y errores. La publicación es idempotente; guardar la decisión y recuperar su entrega
pendiente no ejecuta el Judge otra vez ni cobra otra ayuda. Una solicitud sin recibo sigue la política existente de
gasto incierto y recuperación; no se reenvía como si nunca hubiese existido.

El paquete incluye artefactos completos, capturas, juicios, ensayos hijos y procedencia. `verify` reconstruye decisiones,
estado, selección y entrega sin red, sin inferencia y sin ejecutar nuevos experimentos. Reejecutar mide otra vez y puede
variar. Reproducir el registro no demuestra que un proveedor vaya a generar de nuevo las mismas respuestas.

La identidad del generador incorpora política, contexto, Judge, punto de evaluación y modos de ayuda. La identidad del
evaluador exterior incorpora partición, versiones, casos y límites. Un resultado bajo otra identidad no se importa
como medida válida sin volver a evaluarlo. Las continuaciones mantienen sus cortes y entregas anteriores.

## 12. Encaje técnico

| Pieza existente | Reutilización o ampliación concreta |
|---|---|
| `core/observer.ts`, `core/jev.ts`, `core/output.ts` y sandbox | Observaciones, juicios y composición de la política; adaptador de entrada sobre un recorrido. |
| `learn/assisted/record.ts`, `experience.ts`, `orchestra/reader.ts` | Proyección por corte, experiencia y hechos de atasco; añadir explícitamente ayuda entregada, sin abrir el diario bruto. |
| `learn/assisted/channel.ts` y runner del laboratorio | Consulta opcional antes de la pregunta, consejo con autoría, presupuesto y entrega una vez. |
| `artifacts/store.ts` y protocolo de cambios | Versiones de políticas, padres, contenido y vuelta atrás. |
| `learn/evolve/engine.ts` y `policy.ts` | Búsqueda opcional con evaluador de runs; desarrollo, reparación, reinicios, semillas y continuación. |
| `orchestra/batch.ts`, lanzadores y delegación | Ensayos identificados, reservas, hijos, cancelación y resultados. |
| `runtime/replay.ts`, `package.ts`, resultados y consola | Reconstrucción, identidad de condición, exposición de decisiones y paquete con hijos. |

`core/policy.ts` hoy compone prioridades sobre acciones de búsqueda; no es un planificador de investigación que ya
esté implementado. Se reutilizan sus piezas cuando encajen sin alterar sus invariantes. El módulo nuevo separa
proyección, evaluación del procedimiento y ejecución de ensayos; no introduce excepciones por nombre de mundo.

La implementación valida capacidades por laboratorio. No obliga a soportar de golpe mundos externos, actores
compartidos o cortes contrafactuales: un ensayo completo sobre un laboratorio ya ejecutable basta para investigar
el procedimiento. Un modo no soportado se rechaza antes de gastar; nunca se sustituye por otro silenciosamente.

## 13. Entregas y aceptación

**M1 · Una política utilizable y reconstruible.** Artefacto, proyección, evaluación, consejo por canal y presupuesto.
Pruebas con Judge y junior simulados: desactivarla mantiene el comportamiento previo; sólo ve su prefijo; distingue
hechos y juicios; puede abstenerse; no bloquea al junior ni actúa en el mundo; errores y truncamientos son explícitos;
reanudación sin doble consejo ni doble gasto; entrada obsoleta no se presenta como actual; funciona sin senior.

**M2 · Investigación de políticas y corpus histórico.** Índice de runs y linajes, lector autorizado de orientación
entregada, ensayos interiores y evaluador fijo. Pruebas: un candidato no cambia los checks; estados y recursos de hijos
no se mezclan; caída y cancelación preservan resultados; verificación reconstruye todo sin inferencia; ramas y
continuaciones no inflan la muestra; lectura histórica no se registra como mejora contrafactual. El motor evolutivo
puede medir y desarrollar políticas con este evaluador, sin una segunda autoridad de población o recursos.

**M3 · Piloto con investigadores reales.** Usar el corpus identificado para formular políticas; empezar por un junior
con configuración fija y mundos ejecutables de distinta naturaleza. Incluir tareas donde pueda haber progreso, no
sólo las más difíciles. Grid, cells y orbit son candidatos iniciales; artefactos permite comprobar transferencia a
optimización. c302 y Blender aportan experiencia desde el principio y entran en ensayos cuando su entorno esté listo.
El lote fija casos, condiciones de §10, recursos y criterio antes de lanzarse; ningún nombre de modelo ni presupuesto
histórico se toma como valor implícito. No hace falta terminar otras ampliaciones del arnés para este piloto.

La entrega de software se acepta cuando estos contratos funcionan. **La mejora investigadora se acepta cuando los
runs la muestran.** También se conserva un resultado negativo: una política puede diagnosticar bien y no ayudar al
junior a inventar el experimento necesario. Eso localiza una limitación que un procedimiento no ha sustituido.

### 13.1 Hecho: M1 (28/10/2026)

**Dónde está:**
- **Código:** `lib/src/learn/assisted/research-policy.ts`.
- **Conexión al run:** `--research-policy FILE` en `lib/src/runtime/lab-runner.ts`.
- **Punto antes de cada pregunta:** `advise` en `lib/src/learn/assisted/session.ts`.
- **Pruebas:** `lib/test/research-policy.test.ts`, con un Judge y un junior simulados, incluido un run completo con
  reanudación y paquete.

**El artefacto** `research-policy@1` es un modelo más del arnés. Lleva observaciones en código sobre la captura, reglas
opcionales que responde el Judge y una composición en código `(p, m) => ({ guidance, state })`, más plantillas, estado
inicial y procedencia.
- Se evalúa con el `Observer`, el `Evaluator` y el `Predictor` existentes, en el sandbox `node:vm` con límite de tiempo.
- `checkPolicy` valida el contrato antes de nada.
- `policyHash` identifica lo que se ejecuta; la procedencia queda fuera.

**La captura** (`research-view@1`) es la vista del junior hasta el corte, hecha con la lista de `researcherEvents`:
- en cada petición, si se ejecutó, se rechazó o falló, y su respuesta recortada;
- la ayuda entregada;
- los hechos de `stuckSignals`, calculados sobre esa misma vista;
- sus consejos anteriores, sus recursos y su estado.

Tiene una ventana de los eventos más recientes y declara lo omitido y lo recortado. Nunca incluye nada posterior al
corte ni nada que el junior no recibiera.

**La decisión** se valida contra el contrato:
- el foco es `develop`, `contrast` o `reframe`;
- la plantilla existe y lleva exactamente los argumentos que declara;
- la evidencia está en la captura;
- los juicios son reglas de la política;
- el estado no supera su límite.

El texto sale de la plantilla. Se distinguen `no_context`, `judge_failed` (incluida una regla sin respuesta, que nunca
se toma como neutra), `invalid_output` y `limit`.

**Antes de cada pregunta** del investigador asistido, la decisión se toma tras registrar lo que le llegó. Se anota con
`research_policy_requested` (corte, captura, estado y reserva), `research_policy_decided` (observaciones, respuestas
del Judge, salida o fallo) y `research_policy_delivered` (el mensaje o por qué no se entregó: abstención, fallo,
límite u obsolescencia).
- **Entrega:** el consejo llega como aviso de `agent:research-policy` por el canal, nunca como directiva. Se paga una
  sola vez del presupuesto de ayuda del run.
- **Recursos agotados:** sin ayuda ni límites propios restantes, no hay inferencia.
- **Durante la reproducción** del historial de un run reanudado, no se decide.
- **Obsolescencia:** lo que llega mientras decide vuelve vieja la captura, y el consejo no se entrega como actual.

**Al reanudar,** se usan otra vez las decisiones registradas, sin Judge y sin volver a pagar, y se reescriben palabra
por palabra en el mismo sitio. Una decisión tomada y no entregada se entrega entonces.

**Configuración:** la política forma parte de la condición (`config.research_policy` con hash, contexto, límites y si
usa el Judge). Se guarda entera en el diario. Se rechaza antes de gastar:
- fuera del investigador asistido;
- en la rejilla, que tiene un bucle propio;
- si pide el Judge y el run va con `--flat`.

**Reconstrucción:** `lab verify` comprueba que cada decisión se reconstruye desde su captura y las respuestas
registradas del Judge, sin Judge (`verifyPolicyDecisions`). Además, el run completo se reconstruye fuera de línea.

**La vista de escalada** dibuja el consejo como una cuerda propia, «consejo de la política», separada de las
directivas del senior.

### 13.2 Hecho: M2 (28/10/2026)

**Dónde está:** el código, en `lib/src/meta/` (`corpus.ts`, `lab.ts`, `inspect.ts`), y los comandos, en `lab meta`
(`index`, `inspect`, `trials`, `search`, `verify`). Las pruebas, en `lib/test/meta-lab.test.ts`: una de ellas con runs
reales del arnés y un junior simulado.

**El índice del corpus** (`research-corpus@1`, `lab meta index`) recoge de cada run, sin tocarlo:
- su hash, su mundo y su realización;
- el modelo, el razonamiento y las herramientas;
- la ayuda, por autor, y si tuvo senior o política;
- su presupuesto y su procedencia;
- qué continúa o de quién es rama;
- su resultado;
- si su registro basta para leerlo, reconstruirlo o volver a ejecutarlo.

Los linajes agrupan el original con sus continuaciones y ramas. `partition` asigna linajes enteros y rechaza partirlos;
`independent` cuenta linajes, no archivos. Sobre el corpus local salen 115 runs en 100 linajes, 82 reconstruibles y 49
con ayuda entregada.

**Lo entregado al junior** se lee como experiencia: `{"experience": "guidance", "run": ...}`, con
`--experience-guidance` y sólo en modo `meta`. De cada mensaje da el autor, la pregunta, la ronda, el corte y sus
palabras, y como respuesta:
- el informe de la directiva;
- lo que dijo al senior;
- lo siguiente que escribió, o «desconocido».

Los resultados de ramas no son ayuda, y nunca se expone el diario privado de quien la dio. Sin esa opción, el prompt no
cambia.

**Los ensayos interiores** (`Trials`, manifiesto `meta-lab@1` fijado por el operador):
- **Cada ensayo** es un run completo de un junior fijo con la política congelada, en un caso y una realización del
  manifiesto. Se identifica por manifiesto, caso, repetición y política, y nunca se ejecuta dos veces.
- **Registro:** se anota en `trials.jsonl` antes de despacharse (`research_trial_requested`) y una sola vez al terminar
  (`research_trial_finished`).
- **Caídas:** se reconcilian con el registro del hijo. Uno que terminó se lee sin volver a ejecutarse; uno cortado se
  reanuda desde su registro y su continuación pasa a ser el registro del ensayo.
- **Cancelación:** llega al hijo y conserva lo parcial.
- **Resultado:** se lee sólo del registro del hijo, con la aceptación propia del mundo según el criterio del caso. Un
  hijo que muere es un fallo de la infraestructura, sin medida inventada.

**El evaluador fijo** (`policyEvaluator`) es el contrato del motor evolutivo:
- **El candidato** es un único `policy.json`.
- **La calidad** es, por tipo de mundo, `q = 1 − fracción resuelta` entre los ensayos que pudieron decirlo; menor es
  mejor, comparada primero en el peor tipo y con el vector nombrado.
- **Corrección:** un error propio de la política la vuelve incorrecta; un fallo de infraestructura no mide.
- **Sólo desarrollo:** únicamente se miden los casos de desarrollo; la confirmación es del operador.
- **Búsqueda:** `runSearch` desarrolla políticas con él, sin otra autoridad sobre la población ni sobre los recursos
  (`lab meta search`).

**Que un candidato no cambia los checks** se prueba con runs reales: el mismo caso, con una política que calla y otra
que aconseja, da los mismos checks y veredictos.

**La verificación** (`lab meta verify`) relee cada ensayo de su registro y reconstruye cada decisión de su política sin
Judge, sin ejecutar nada.

**La lectura histórica** (`lab meta inspect`, `policy-inspection@1`) da lo que la política habría decidido antes de cada
respuesta de un run ya hecho. Va marcada `counterfactual: false` y nunca se registra como ensayo ni como mejora.

#### 13.2.1 Una revisión externa de M2, conciliada (28/10/2026)

Siete garantías que podían alterar las comparaciones, el gasto o la reproducción. Cada una se corrige por su principio,
con una prueba que reproduce el caso (`lib/test/meta-lab.test.ts`, «M2 review»).

1. **Un ensayo es su configuración efectiva.** El lanzador declara la identidad con la que ejecuta sus hijos: el modelo
   de System 2, la ruta y el ajuste de su endpoint y el modelo del Judge, nunca una clave. Esa identidad entra en el id
   del ensayo y queda registrada. Con otro modelo, el ensayo es otro y nada del primero se reutiliza. Un hijo cuyo
   registro dice que corrió con otro modelo es un fallo de infraestructura, no un resultado.
2. **El registro de un ensayo es el conjunto de archivos de su run.** Al reanudar, no se copia el diario: el ensayo
   apunta a su continuación (`record` en `research_trial_finished`), y su hallazgo, que está al lado, cuenta. Un éxito
   tras reanudar sigue siendo un éxito, y `verify` lo lee del mismo sitio.
3. **Los controles de un ensayo viajan con él.** Un run reanudado toma sus controles de nuevo, así que al reanudar se le
   vuelven a dar los límites de tokens y tiempo (`controlArgs` del runner).
4. **El trabajo interior se reserva del presupuesto exterior y se liquida (§11).**
   - **Manifiesto:** fija el `--max-tokens` del junior, que es lo que se reserva.
   - **Cada lanzamiento** reserva ese máximo antes de despacharse y liquida lo gastado en vivo después (lo desconocido,
     a lo reservado). Uno que el fondo no puede sostener no se lanza (`unfunded`), y la búsqueda se detiene ahí sin
     llamarlo medida.
   - **`meta search`** exige `--trial-tokens`, porque su `--tokens` sólo limita al mutador. Sus evaluaciones se acotan
     a lo que el fondo puede sostener, e informa por separado del gasto del mutador y del de los ensayos.
5. **Una búsqueda nunca pisa a otra.** Cada una escribe un registro propio en `searches/`. Una se continúa sólo con
   `--resume`, que lee su registro y escribe uno nuevo.
6. **Una política se nombra por toda su configuración** (política, contexto y límites): con otros límites, otro archivo
   y otro ensayo.
7. **`verify` comprueba el manifiesto que se le da y reconstruye la selección evolutiva.**
   - **Por ensayo:** cada uno debe estar registrado con el hash del manifiesto y con los argumentos de su caso.
   - **Por búsqueda:** cada búsqueda sellada se reconstruye desde su registro sin modelo ni medida (`verifySearch`, con
     un evaluador de políticas por contenido). Cada evaluación se recalcula desde sus ensayos y se contrasta con el
     registro de ensayos.

#### 13.2.2 Una segunda revisión externa de M2, conciliada (28/10/2026)

Seis fallos reproducibles antes del piloto pagado. Cada uno se corrige por su principio, con una prueba que reproduce el
caso (`lib/test/meta-lab.test.ts`, «M2 review 2»).

1. **Una medida es una evaluación completa.** Una evaluación a la que le falta algún ensayo (uno que el fondo no pudo
   sostener, una cancelación, ensayos que no se alcanzaron) se guarda como es: incompleta, con su corrección sin
   comprobar y sin calidad (`measureOf`). Nunca compite con las completas ni entra en las élites. `verify` la recalcula
   igual.
2. **Un registro sólo sirve sus medidas al evaluador que las tomó.** La identidad del evaluador incluye la configuración
   efectiva del lanzador (`Trials.identity`). El motor evolutivo rechaza reanudar un registro bajo otra identidad, en
   cualquier búsqueda, no sólo en la metapolítica. Con otro modelo se continúa desde el sello, y su evidencia se mide
   otra vez.
3. **Un registro nunca se sobrescribe.** El registro de un ensayo es el último archivo de su cadena que existe. Una
   continuación que falló antes de crear su diario queda como intención fallida en el registro de ensayos, nunca como
   registro. La siguiente reanuda el último que existe, con un nombre libre.
4. **El fondo reserva todo el trabajo de un ensayo, también las llamadas al Judge.**
   - **Nuevo límite:** el runner admite `--max-judge-calls`, un control como `--max-tokens` que se comprueba entre
     preguntas (`judge_budget`).
   - **Manifiesto:** lo exige.
   - **Fondo y liquidación:** `lab meta` tiene un segundo fondo, `--trial-judge-calls`, obligatorio en `search`. Cada
     lanzamiento reserva ambos máximos y liquida lo hecho en vivo: los tokens y las llamadas al Judge
     (`replay.live.jev`).
   - **Trabajo sin cota:** el manifiesto rechaza lo que ningún límite suyo acota (`--delegation-fund`, cuyas ramas
     llaman a su propio Judge; `--agents`; `--opening`). La condición con senior es de un lote, no de un ensayo.
5. **Un registro hecho con otra configuración nunca es el resultado de este ensayo.** Tampoco al reconciliar: se
   comprueba la configuración antes de leer el final y antes de reanudar. Queda como fallo de infraestructura, y no se
   reanuda en este ensayo.
6. **Una evidencia sin su ensayo no es evidencia.** `verify` falla si alguna evaluación de una búsqueda cita un ensayo
   que no está pedido y terminado en el registro de ensayos.

**Lo que queda:** el límite de llamadas, como el de tokens, se comprueba entre preguntas a System 2. Una tanda de
juicios puede pasarse del máximo, y la liquidación registra lo que de verdad se hizo.

### 13.3 M3 preparado, sin lanzar (28/10/2026)

El piloto real gasta inferencia y lo lanza el operador. Queda listo en `lib/examples/meta.pilot.md`, con las órdenes,
lo que pregunta cada condición y cómo leerlo.

**La política también en la rejilla:** antes se rechazaba en ese laboratorio. Ahora su cliente tiene el mismo punto
`advise`, y lo prueba un run de la rejilla con consejo entregado y reconstruido.

**Dos políticas iniciales,** en `lib/examples/research-policies/` y sólo de código:
- **`reminder.json`:** el recordatorio fijo del §10. Su texto y su calendario (la primera pregunta de cada ronda par
  desde la 2) se fijaron antes de probar candidatas.
- **`situated.json`:** la candidata situada, escrita desde las semillas del catálogo (localizar una regresión,
  replantear, discriminar alternativas, desarrollar una predicción) y los hechos de atasco del orquestador. Da como
  mucho un consejo por ronda y no repite el mismo en dos rondas. Esto último se añadió tras inspeccionarla contra el run
  de c302 con senior, donde habría repetido «discriminate» en todas las rondas.

**El manifiesto** `lib/examples/meta.pilot.json`:
- un junior fijo: 8 rondas, 8 ayudas, memoria selectiva, 800 000 tokens y 240 minutos; el modelo, el del lanzador,
  queda registrado;
- cinco casos de desarrollo, en cells nivel 3, orbit nivel 2 y la rejilla;
- cuatro de confirmación, uno de ellos en artefactos (`dedup`) para ver si se transfiere a la optimización.

**El lote** `lib/examples/batch.meta-pilot.json`: las condiciones A a D del §10 (junior solo, recordatorio, candidata y
senior) sobre tres casos de desarrollo de distinta naturaleza. Las doce configuraciones se comprobaron hasta su primera
pregunta, sin gastar.

La mejora investigadora sólo se aceptará cuando los runs la muestren. Hasta lanzarlos, M3 no tiene resultado.

**Pendiente:**
- **El piloto en sí:** el lote y los ensayos, que lanza el operador.
- **La condición política más senior.**
- **El catálogo y el selector** de CATALOGO-METAPOLITICAS-INVESTIGACION.

#### 13.3.1 El primer ensayo real, leído (28/10/2026)

El primer ensayo de `situated.json` en `cells-l3-s1` (junior `recursive/flint-v1.0:free`) no midió la política.

- **El Judge contestó HTTP 402 Payment Required** en todos los puntos de sus dos checks: el modelo «no se sostenía»
  porque no había respuestas, no por lo que predecía. El junior lo comunicó tres veces como fallo del instrumento.
- **System 2 contestó HTTP 429 Too Many Requests** en ocho propuestas, y la ronda 1 se perdió entera.
- **La política respondió a sus señales:** aconsejó una vez («discriminate», tras dos checks sin sostenerse). En este
  caso, la causa era el proveedor del Judge.

**Corregido por su principio:**
- **Un ensayo que sus proveedores hicieron fallar no mide nada (`trialResult`).** Cuenta como `infra` si alguna llamada
  al Judge falló tras sus reintentos (un check sin sus respuestas no es un veredicto), si alguna propuesta quedó sin
  respuesta de System 2 (una ronda perdida por el proveedor, no por el método) o si la run paró por `llm_error`. Antes,
  un final normal se leía como `ended, not solved`.
- **El estado inicial de `situated.json` es `round: -1`.** Con `0` coincidía con la ronda 0, y en la primera pregunta
  se abstenía diciendo que ya había aconsejado en esa ronda. El cambio da otro hash, así que es otro ensayo.

**Para relanzar:** saldo en la cuenta del Judge y, para System 2, un modelo sin un límite de peticiones tan estricto.

## 14. Resultado esperado

Se entrega una política ejecutable y legible, su procedencia, los casos donde ayudó o falló, las decisiones que tomó,
los resultados de los runs y un paquete reconstruible. Puede ser general o especializada, según lo efectivamente
contrastado. No se exige redescubrir una metodología nueva para reconocer una mejora práctica.

El siguiente paso lo decide la evidencia: ampliar las decisiones que aprende, transferirla a otro junior, combinarla
con un senior o utilizar las trayectorias para entrenar pesos. Ninguna de esas ampliaciones es requisito para probar
la idea central: **aprender qué orientación permite a un modelo pequeño investigar mejor, y conservar ese aprendizaje
como un procedimiento que otra investigación pueda reutilizar.**

Referencias de diseño consultadas el 27/10/2026: [composición de juicios](https://docs.typesafe.ai/patterns/composite-scoring),
[descubrimiento de preguntas mediante un bucle de evaluación](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery)
y [significado de la confianza](https://docs.typesafe.ai/confidence). Orientan la separación entre observación, juicio
y composición; no prueban que esta metapolítica vaya a mejorar a nuestros investigadores.

## 15. Catálogo, selección dinámica y evolución del método

Ampliación acordada el 28/10/2026, definida en
[CATALOGO-METAPOLITICAS-INVESTIGACION](CATALOGO-METAPOLITICAS-INVESTIGACION.md): conservar procedimientos como skills
reutilizables, seleccionar cuál aplicar durante un run y evolucionar tanto sus políticas como su selector y composición.
Incluye siete semillas documentales; ninguna se presenta como procedimiento aprendido o validado.

M1 conserva su contrato de política individual. Sobre M1 y M2 se materializa un catálogo versionado; la selección
dinámica cambia la entrada activa dentro del mismo artefacto congelado, sin editarlo durante el ensayo. Se distingue
la elección explícita del investigador de la elección automática mediante un selector investigable.

La búsqueda evolutiva conserva su población y su contabilidad actuales. Su nuevo evaluador prueba el repertorio completo
con el junior, permitiendo conservar especialistas complementarios. Una política menos útil en solitario puede ser
útil en un catálogo; su contribución se contrasta, no se deduce de que estuviera activa antes de un éxito.

El bucle puede usar el repertorio de una generación para investigar el de la siguiente, con evaluador fijo y recursos
declarados. Esa utilización efectiva del método mejorado en la siguiente metainvestigación es lo que permite estudiar
automejora recursiva del procedimiento. El catálogo detalla las transiciones, condiciones y pruebas de esta extensión;
su implementación no se presume por disponer de M1.
