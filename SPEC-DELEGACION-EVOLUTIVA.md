# SPEC · Delegación evolutiva: abrir caminos mediante búsqueda de programas

Estado (25/10/2026): **contrato consolidado para desarrollo; H1 y H2 implementadas (§16.1, §16.2)**.
Las decisiones normativas están incorporadas en el cuerpo. §16 define entregas y pruebas; §17, los límites de integración.
Reformula el borrador «evolucionar primero, explicar después» aportado por el autor. Esta versión es autocontenida:
no requiere una SPEC de búsqueda diversa ni un archivo especializado ya implementado.

Extiende [la delegación](SPEC-DELEGACION-INVESTIGACIONES.md) y reutiliza
[el mundo de artefactos](SPEC-MUNDO-ARTEFACTOS.md), [los instrumentos propios](SPEC-INSTRUMENTOS-PROPIOS.md)
y [las pruebas propias](SPEC-PRUEBAS-PROPIAS.md).
Diseño de referencia: [ShinkaEvolve, revisión 8adc053](https://github.com/SakanaAI/ShinkaEvolve/tree/8adc053) (Apache
2.0). El primer backend es **nativo del arnés** (§14); Shinka queda como referencia de diseño y como backend opcional
posterior, con el SHA completo, dependencias y configuración fijados si llega a usarse. Nunca una rama móvil.

## 1. Qué problema queremos resolver

**El investigador puede trabajar con método y aun así recorrer una y otra vez variantes de la misma idea.**
Pedirle que sea creativo no garantiza otra dirección. Necesitamos otra manera de explorar: mantener alternativas,
transformarlas, ejecutarlas y utilizar lo que el mundo devuelve para decidir desde dónde seguir.

Una rama evolutiva busca programas y devuelve material que permite continuar: una mejora utilizable, una alternativa
con otro comportamiento, una combinación prometedora o un fracaso que acota qué no merece más esfuerzo.
No necesita inventar de una vez una hipótesis brillante. Una secuencia de cambios puede construir algo que no surgió
en una propuesta directa; reinicios, recombinaciones y analogías pueden cambiar el punto de partida cuando los cambios
locales no abren camino. Que lo consiga es algo que se observará, no una garantía del término «evolución».

**El objetivo es resolver problemas y ampliar la búsqueda efectiva.** No se pide demostrar novedad mundial ni producir
una explicación académica de cada variante. Interesa encontrar algo que el investigador pueda ejecutar, inspeccionar,
modificar y aprovechar, conservando cómo se encontró.

## 2. Encaje: una herramienta de búsqueda, no el método obligatorio del investigador

Se conserva el investigador general y su libertad para organizar cuadernos y artefactos. El archivo de esta rama es
estado interno de un algoritmo de búsqueda, consultable y exportable; no sustituye la memoria del investigador ni le
impone organizar sus hipótesis en celdas.

El operador habilita el modo y sus recursos. Junior o senior deciden solicitarlo mediante `delegate`. La delegación
normal continúa disponible; no se convierte silenciosamente en evolución. No se obliga a delegar al detectar atasco.

La nueva capacidad aporta **ejecución especializada de muchos intentos con selección y memoria**, no herramientas
que el investigador no pudiera conceptualmente construir. Se implementa para hacer ese recorrido fiable, acotado y
reutilizable. El modelo sigue proponiendo transformaciones; el mundo aporta feedback y la política de búsqueda decide
qué variantes conservar activas y desde cuáles continuar.

## 3. Contrato de solicitud

```json
{
  "investigate": [{
    "delegate": {
      "mode": "evolve",
      "question": "Busca alternativas a la versión actual que permitan seguir avanzando. Devuelve programas que merezca probar y dónde cambian de comportamiento.",
      "start": "artifact:7588baecd7b6483d",
      "refs": ["model:r12", "note:failed-attempts"],
      "expected": "Una mejora utilizable o una dirección distinta con una prueba concreta para continuar.",
      "budget": { "evaluations": 60, "tokens": 300000, "rounds": 2 }
    }
  }]
}
```

- `mode`: `investigate` por defecto, o `evolve`. Valores desconocidos se rechazan, nunca se ignoran.
- `start`: un artefacto o modelo autorizado, separado de referencias documentales. Si se omite, se resuelve a la versión
  activa del solicitante, al último modelo compatible o a la base del mundo, en ese orden aplicable, salvo que se use
  `continue_from`. La respuesta confirma el hash concreto. Si no hay inicio ejecutable se rechaza con motivo.
- `continue_from`: ID autorizado de un manifiesto de búsqueda sellado (§13.1), opcional y excluyente con `start`.
  Importa población, medidas compatibles e historial para continuar deliberadamente con otra reserva y otro encargo.
  La respuesta identifica el corte importado y lo que necesita reevaluarse. No es una reanudación tras caída.
- `refs`: orientan la lectura; no conceden acceso ni seleccionan ambiguamente el genoma inicial.
- `seeds`: referencias autorizadas a otros candidatos, runs o conceptos, opcionales. Son IDs del catálogo de experiencia
  del run, no rutas arbitrarias proporcionadas por el modelo. El operador autoriza las fuentes y el límite de semillas.
- `budget.evaluations`: máximo de evaluaciones de candidatos, incluidas repeticiones destinadas a decidir selección.
  No se llama «generaciones» a una cantidad ambigua de propuestas, intentos de parche y ejecuciones.
- `tokens`: total de la rama, incluidas propuestas, revisión, jueces y entrega. `rounds`: máximo de rondas del investigador
  de consolidación. Se conservan además límites separados de intentos, ejecuciones primitivas y máquina (§12).

**Reutiliza el ciclo de vida y la contabilidad de la delegación existente** (`lib/src/learn/assisted/delegation.ts`),
**adaptando el formato de ejecución y de resultado.** Se reutilizan tal cual: el mismo `delegate`, el fondo y su libro
compartido por junior y senior, una rama a la vez, `status`/`read`/`cancel`, latido y pid, reconciliación al reanudar,
gasto incierto retenido y resultado como `research_result` que no cuenta como ayuda. `mode: "evolve"` cambia qué se lanza
(el supervisor de §14 en lugar de un run del investigador general) y añade `evaluations` a lo concedido.

Hoy `refresh` lee el estado y el gasto del `end` del diario del hijo y de su finding, y `reportOf` arma la entrega desde
su cuaderno, propuestas y reflexiones. El supervisor no los produce por sustituir el lanzador, así que se resuelve con
dos piezas:
- **Un formato común de ciclo de vida.** El supervisor escribe un diario de rama con eventos, un `end` con su
  `stoppedBy`, su `status` con latido y pid, y un finding cuyo `cost.total` agrega **las dos fases**, búsqueda y
  consolidación, con lo desconocido declarado. `refresh`, la vivacidad y la liquidación funcionan sin cambios, y nunca
  se liquida sólo el coste de una fase.
- **Un adaptador de informe por modo.** `reportOf` despacha según el modo. El evolutivo arma la entrega del §4 desde el
  manifiesto sellado de candidatos (§13) y, si la hubo, desde la consolidación. Una búsqueda parcial o una
  consolidación fallida dan un informe con lo que hay y su estado (`unreviewed`, §9), nunca uno vacío.
- **`read` sobre la rama** lee el recorrido por el mismo adaptador de experiencia que la consolidación (§9).

El fondo, el libro y las reservas no se reimplementan.

La respuesta inmediata incluye ID, modo, inicio resuelto, capacidades, recursos concedidos y reserva para consolidación.
Negativas: modo deshabilitado, evaluador ausente, recursos insuficientes, inicio incompatible o inaccesible, aislamiento
requerido no disponible, otra rama activa o fuentes no autorizadas. Un inicio incorrecto pero ejecutable puede entrar
en reparación si el perfil lo permite; nunca se declara correcto por ser la base.

## 4. Qué entrega al solicitante

El resultado es un `research_result` de delegación con:

1. Un conjunto pequeño de candidatos materializados, identificables y ejecutables, con archivos y dependencias.
2. Qué se midió y qué cambió respecto al inicio: mejoras, pérdidas, condiciones y fallos.
3. Motivo para volver a explorar cada candidato: comportamiento, mecanismo sospechado o prueba pendiente.
4. Estado de las explicaciones: propuesta, contrastada en estas condiciones, contradicha o pendiente.
5. Referencias al recorrido completo, coste y límites de lo observado.
6. Un manifiesto de búsqueda sellado e importable para continuar sin reducir todo el trabajo al mejor programa.

La entrega no tiene que contener una hipótesis nueva ni ganar en todas las condiciones. Una solución más rápida con
el mismo mecanismo es útil si ayuda a resolver la tarea; no se confunde con abrir una dirección distinta. Una variante
distinta sin utilidad visible puede entregarse como línea pendiente, sin presentarla como avance confirmado.

No se entrega sólo un resumen verbal: el padre debe poder recuperar y adoptar explícitamente un candidato, volver a
ejecutarlo o modificarlo. Importar material no lo acepta automáticamente; pasa por sus comprobaciones habituales.

## 5. Evaluador: reutilizar el mundo y delimitar el feedback

Cada mundo compatible declara `EvolutionEvaluator`: representación mutable, versión base, validación del genoma,
materialización, conjunto autorizado de exploración, ejecución, medidas, descriptores opcionales y exportación.
Las mutaciones no pueden modificar evaluador, entradas reservadas, comandos del harness ni reglas de corrección.

En artefactos se usa `ArtifactWorld` para ejecutar y comprobar salidas. El puente no reimplementa la tarea en Python.
Puede evolucionarse el conjunto de archivos autorizado, no obligatoriamente un único bloque de `main.py`. Si el motor
requiere marcas, el adaptador las añade a su representación sin perder el hash del programa realmente ejecutado.

Las evaluaciones emplean un manifiesto explícito de workloads de exploración, con IDs y semillas. El rol dinámico de
una familia no es por sí solo un permiso: el puente sólo acepta el conjunto concedido a esa rama. Checks, confirmaciones
y referencias reservadas no se incluyen como cargas de selección. Su información previa en el linaje se declara.

En artefactos, ese manifiesto de exploración es **fijo durante la rama**, para que los candidatos se comparen sobre las
mismas cargas. Seleccionar muchas veces sobre las mismas entradas favorece programas ajustados a ellas. Por eso, todo
candidato que se exporta se confirma antes con **realizaciones nuevas** de las mismas familias (§8, §11), y la entrega
dice si la confirmación lo sostuvo. En leyes, las cargas se refrescan según el §10.

**La calidad frente al objetivo es la de la tarea, no una métrica elegida por el puente.** El evaluador aplica a las cargas
de exploración la misma maquinaria de veredicto del mundo (`judge` de `lib/src/artifacts/task.ts`), frente a la
referencia y con sus repeticiones intercaladas: el cociente con su intervalo en las tareas de tamaño, y la pendiente con
su intervalo en las de crecimiento (`Objective.growth`, como `threesum-subquadratic@1`). Así una rama no puede
seleccionar por `wall_ms` bruto lo que la tarea juzga por crecimiento.
Esto define rendimiento y aceptación, no todas las razones para invertir otro intento. Desarrollar una alternativa,
repararla o caracterizarla puede no mejorar aún ese objetivo. El reparto de oportunidades de §6–§7 es independiente
del orden de calidad y no cambia el criterio final del mundo.

**Ordenar candidatos por el extremo del intervalo que la tarea usaría para decidir es una heurística de selección, no
una prueba de superioridad.** Cada intervalo es frente a la referencia, no entre candidatos. Un cambio de orden no se
etiqueta como mejora demostrada, y la incertidumbre se conserva junto a cada candidato. Cuando una decisión lo justifica
por su coste (exportar una élite, o descartar una línea entera), se confirma con medidas comparables adicionales,
intercaladas. No se exige un contraste nuevo para cada selección: el motor busca con información imperfecta y
presupuesto finito.

**`holds` no es requisito para sobrevivir ni para ser padre.** Son cuatro decisiones distintas:
- **Corrección:** habilita a competir como programa válido. La reparación tiene su cola aparte.
- **Calidad e incertidumbre:** orientan la selección y la reevaluación.
- **Diversidad y reinicios:** reservan oportunidades para otras vías, dentro de una población acotada (§6–§7).
- **`holds`:** aceptación por el criterio de la tarea. Se registra, pero no sustituye a las anteriores.

Una alternativa correcta, inferior o de medida incierta puede ser el peldaño hacia algo que el mejor candidato actual
no alcanza. No pierde su oportunidad por no tener `holds`. Todos estos estados están acotados a las cargas evaluadas;
un `holds` de exploración nunca se convierte en aceptación final del mundo.

La corrección es una puerta de selección, no un pequeño término de la puntuación: una versión que responde mal no
desplaza una correcta por ser rápida. Se conservan también intentos incorrectos, errores y timeouts. Una cola de reparación
acotada puede utilizar programas casi ejecutables o hipótesis incompletas, pero sus descendientes deben volver a superar
las comprobaciones; nunca se mezclan con las élites correctas.

El feedback útil incluye fallos de ejecución, contraejemplos autorizados, medidas y diferencias. En el perfil inicial
el mutador recibe medidas numéricas de exploración: ocultarlas no es un requisito para esta herramienta optimizadora.
Se declara `feedback: exploration_metrics` y se registra. Esto no contradice el principio del proyecto de que el
entorno no da métricas al investigador: son las medidas de las cargas de exploración, las mismas que el investigador
obtiene con sus propios runs (`act run`). Las cifras de los checks, la familia y los ciegos siguen ocultas para todos.
El perfil `ordinal` es una alternativa compatible, que filtra también prompts de historial e inspiraciones. Ningún perfil concede cifras ocultas de checks o del evaluador.
El investigador de consolidación usa sus herramientas ordinarias y medidas de exploración autorizadas; no se afirma
«sin métricas» mientras se las devuelve indirectamente por sus instrumentos.

## 6. Población y archivo: conservar caminos sin premiar ruido

Se mantienen separados:

- **Registro íntegro:** todos los intentos, resultados y linajes; nunca se borra por perder una competición.
- **Población activa:** candidatos desde los que se decide seguir, limitada por recursos.
- **Archivo de comportamiento:** vista opcional que ayuda a repartir búsqueda entre comportamientos medidos.

### 6.1 Admisión, desarrollo y retirada

El perfil `balanced@1` usa tres conjuntos con límites explícitos: élites por calidad (4), candidatos en desarrollo (8)
y reparación (2), más una cola de admisión pendiente (32). Son valores predeterminados configurables, registrados
en la identidad del perfil. Los conjuntos referencian candidatos del registro; no copian ni borran programas.

La identidad del candidato es el hash del manifiesto materializado: rutas relativas normalizadas, contenido de todos
sus archivos y dependencias declaradas. No se normaliza el significado del código para deduplicar. Inicio, semillas
y reinicios crean raíces de linaje; una mutación las hereda y una recombinación conserva la unión de las de sus padres.
«Otro linaje» significa sin raíces compartidas. Un duplicado conserva todos sus orígenes en el registro, pero no cambia
la identidad ni el linaje de selección de su primera admisión; repetir un programa no lo convierte en otra alternativa.

- Cada candidato ejecutado y correcto, de hash nuevo, entra en la cola de desarrollo aunque no mejore al padre o no
  tenga `holds`. Una medida de calidad ausente no impide desarrollarla si la corrección pudo comprobarse. La falta de
  comprobación de corrección es `unchecked`, no correcta: espera evaluación, sin competir como élite.
- Se llenan plazas de desarrollo en orden de llegada. Cada admisión concede 2 intentos de descendencia. Se elige en
  rotación entre candidatos activos, no por rendimiento. Consumir la cuota libera su plaza; otra admisión ocupa el
  lugar. Las plazas con cuota pendiente no se expulsan por aparecer un programa más rápido.
- Un descendiente correcto de hash nuevo obtiene su propia admisión; puede continuar una cadena que atraviesa varios
  pasos sin mejorar. Un hash ya desarrollado no recibe otra cuota por reaparecer o por cambiar de nombre.
- Si la cola pendiente está llena, el candidato nuevo no entra en ella: queda registrado sin admisión, con motivo
  `admission_capacity`. La cola se sirve y se recorta por extremos distintos: nunca se descarta al que está a punto
  de recibir plaza. No se promete desarrollar todos los candidatos ni completar cuotas si termina el presupuesto.
- Las élites se actualizan por la calidad de §5; un candidato puede ser élite y estar en desarrollo, pero sólo tiene
  una cuota de desarrollo. Para varias familias el evaluador declara el comparador y tratamiento de valores ausentes;
  en artefactos se usa el extremo superior de `growth.interval` si el objetivo es de crecimiento, o de `interval` en
  otro caso. Se ordena el vector de familias de peor a mejor y se comparan esos vectores lexicográficamente, menor
  primero. Se exige corrección en todas las cargas previstas y cada componente ausente ocupa el peor valor; sin
  calidad disponible no entra en élites. Empates exactos conservan el anterior, por ID de admisión. Esto es selección,
  no prueba de dominancia. Las restricciones secundarias y su cumplimiento se conservan en el veredicto, sin borrar
  la oportunidad de desarrollo de quien aún las incumple.
- Fallos ejecutables o parches materializados incorrectos entran en reparación, con 2 intentos por admisión. Las plazas
  se llenan por llegada y rotan sin expulsar cuotas pendientes; si están llenas, el nuevo fallo queda registrado sin
  admisión. Cada plaza conserva origen, versión de trabajo y cuota restante. Una reparación materializada pero todavía
  incorrecta actualiza esa versión y consume la misma cuota, sin abrir otra plaza; un parche inválido conserva la
  anterior. Una reparación correcta libera la plaza y vuelve al circuito normal. Un hash ya admitido no obtiene
  otra reparación por reaparecer.
  Un fallo de transporte del LLM se reconcilia como infraestructura, no se considera programa para reparar.

La cuota se consume al registrar la respuesta del mutador, incluso si devuelve un duplicado o parche inválido.
Una llamada de estado incierto mantiene su plaza y reserva hasta reconciliación; nunca se relanza para regalar cuota.
Un parche inválido conserva diagnóstico para el próximo intento del mismo candidato. Los límites de reparación
evitan cadenas ilimitadas de errores que se conceden trabajo a sí mismos.

### 6.2 Archivo opcional

No se exige una taxonomía universal. Si el evaluador no ofrece descriptores, la búsqueda funciona con calidad,
linajes, reinicios y reparto entre poblaciones. Si los ofrece, se fijan definición, bins, unidades, incertidumbre y
versión. Son comportamientos, no certificados de mecanismos. El investigador puede proponer descriptores mediante
instrumentos autorizados para el perfil de una nueva búsqueda. No se redefinen las celdas de una rama ya abierta.

Cada celda conserva hasta `cell_capacity` candidatos (2 por defecto): el mejor por calidad y, si cabe, el más reciente
de otro linaje; los empates se resuelven por ID de intento. No es un clasificador de mecanismos. Sin otro
linaje se retiene el siguiente por calidad; plazas adicionales, si se configuran, se llenan por calidad entre los
restantes. Compartir celda no excluye la admisión de §6.1. Un candidato sin descriptor
fiable sigue en el circuito normal y queda pendiente de caracterización. El archivo tiene máximo de celdas activas
(32 por defecto); al llenarse se archiva la celda menos recientemente seleccionada, conservando íntegro su registro.

La elección de celda y la elección de padre son distintas. En turnos de explotación alternan élites globales y archivo
si existe; las celdas se recorren desde la menos recientemente seleccionada y sus ocupantes en rotación. Sin archivo
se recorren las élites en rotación. Nada de ello consume ni elimina las cuotas de desarrollo.
**No se suma una prima histórica de celda nueva a la calidad permanente del programa.** Abrir una celda es un evento
que puede recompensar al operador que la produjo; después, sus ocupantes compiten por calidad y complementariedad.
No se usa `min(1, referencia/métrica)` para distinguir mejoras que esa saturación vuelve indistinguibles.

La evaluación de una novedad se hace contra una revisión del archivo y se confirma serialmente: dos trabajos paralelos
no cobran ambos haber abierto la misma celda. Ruido y mediciones insuficientes no acreditan novedad. Las fronteras
dudosas requieren repetir o conservar el estado incierto. Los embeddings no sustituyen medidas del mundo.

## 7. Transformaciones y salida de una búsqueda estancada

Operadores disponibles: modificación local, reescritura, recombinación, reparación, inicio desde cero y transformación
por analogía. No se obliga a que cada diff «rompa un supuesto»: una mejora local puede construir un peldaño útil.
Cada propuesta conserva autor/modelo, padres, cambio y motivo declarado, sin tomar ese motivo como explicación verdadera.

### 7.1 Seleccionar padre y seleccionar transformación son decisiones distintas

`balanced@1` recorre el ciclo de turnos `[desarrollo, explotación, desarrollo, reparación, reinicio]`. Desarrollo y
reparación usan las rotaciones y cuotas de §6.1; explotación usa §6.2. Si un conjunto está vacío se intenta desarrollo,
explotación y finalmente reinicio, en ese orden, sin seleccionar programas incorrectos como élites. Los reemplazos
se registran. El inicio se evalúa primero y entra en estos mismos conjuntos, sin privilegio de corrección.

Para los turnos con padre correcto se recorre, por candidato, `[local, reescritura, local, recombinación]`.
Recombinación toma como segundo padre el correcto activo menos recientemente usado de otro linaje, y si no existe,
otro hash distinto; sin segundo padre se transforma en reescritura. Reparación y reinicio tienen su operador propio.
El cursor de turnos y los cursores por candidato se preservan. El plan no depende del orden de resultados de benchmarks
concurrentes: se confirma por ID de intento; H1 ejecuta un intento completo cada vez.

Estos valores definen una política inicial implementable, no una regla universal de creatividad. Cambiarlos crea
otra versión de perfil. El motor nunca confunde variar el operador con conceder trabajo a otro padre.

### 7.2 Contrato de contexto del mutador

Toda llamada incluye tarea, contrato de archivos/entrada/salida, restricciones y operador. Sus datos autorizados se
seleccionan y fijan antes de generar; el contexto efectivo completo queda registrado con hash.

| Operador | Contexto específico |
|---|---|
| Local o reescritura | Padre completo, medidas por workload, incertidumbre y últimos fallos pertinentes de su linaje |
| Reparación | Programa o parche recuperable, error/contraejemplo concreto y condiciones que debe conservar |
| Recombinación | Ambos programas y sus resultados diferenciados; no se presupone que combinarlos sea beneficioso |
| Reinicio | Contrato de tarea y observaciones autorizadas del encargo; no incluye código de élites ni resumen de su mecanismo |
| Analogía, si está habilitada | Concepto y procedencia, correspondencia propuesta y material del destino necesario |

Los motivos del padre y del mutador se etiquetan como declaraciones, no como hechos medidos. Cada llamada incorpora
como máximo los últimos 3 diagnósticos del mismo candidato y 3 intentos ya probados del mismo operador y linaje,
sin duplicarlos. Se priorizan fallos concretos y resultados contradictorios; orden por recencia con IDs de desempate.
El contexto tiene un límite configurado; nunca se truncan silenciosamente archivos requeridos. Si no caben, se utiliza
un contrato explícito de archivos editables y lecturas por referencia, contabilizadas, o se rechaza ese intento.

Los reinicios abren contexto nuevo: heredan tarea y datos autorizados, no la conversación de la línea dominante.
Un duplicado exacto devuelve al generador su ID y diagnóstico de duplicación en el siguiente intento de esa línea,
sin ejecutar de nuevo ni afirmar que se descubrió otra solución. La cache de resultados incluye versión de programa,
evaluador, workloads y entorno; una repetición solicitada para medir ruido nunca se satisface con la misma medida cacheada.

### 7.3 Dos clases de estancamiento

Cada respuesta de generación cuenta como intento, incluso duplicada o inválida. Tras 5 intentos consecutivos sin
candidata nueva ejecutable, se activa recuperación de generación: los siguientes 2 intentos son reinicios en contexto
nuevo, con los diagnósticos concretos de esos fallos, sin el programa dominante. El contador se rearma después de
esos dos intentos; no exige completar evaluaciones para reaccionar. Los intentos forzados consumen presupuesto y
avanzan el cursor ordinario; no generan cuotas extra para padres que no se usaron.

Cada bloque de 10 evaluaciones de hashes nuevos completadas mide desarrollo; las reevaluaciones actualizan evidencia,
pero no llenan artificialmente la ventana. Progreso significa mejora del mejor vector de calidad respecto al inicio
del bloque por encima de la tolerancia, comportamiento confirmado nuevo o reparación que vuelve correcto a un programa
antes fallido. La tolerancia de artefactos es `objective.margin` en las unidades del componente decisivo del vector;
otro valor debe quedar en el perfil. Es una señal operativa, no una prueba estadística de mejora. Dos bloques sin
progreso activan recuperación de desarrollo durante 5 intentos: `[desarrollo, reinicio, desarrollo, reinicio, desarrollo]`,
con reescritura en los turnos de desarrollo y el mismo reemplazo de §7.1 si no hay padre. Las oportunidades normales
pendientes no se borran. Cada intento avanza también el cursor ordinario; sólo se consume cuota y cursor de operador
del padre efectivamente usado. Al terminar se abre una ventana nueva y se vuelve al ciclo normal. Si coinciden ambas
recuperaciones, generación tiene prioridad y se pausa la de desarrollo.

Se registran señal, ventana de intentos/evaluaciones, transición y efecto en la selección. No se interpreta ruido
como progreso confirmado ni se diagnostica un fallo de red como incapacidad creativa. Sin más recursos, termina la
búsqueda y entrega parciales; no entra en un ciclo de reinicios sin límite.

El bandit de modelos es opcional. Si se usa, conserva una cuota mínima de exploración, estado y recompensas separadas
de apertura, mejora y corrección; no premia sólo celdas nuevas ni elimina permanentemente una vía tras pocos fallos.
No se añade un bandit de conceptos hasta que haya datos que lo justifiquen; las analogías pueden alternarse o muestrearse
con una política declarada y un coste acotado.

No hay rechazo LLM por «no novedoso» como puerta predeterminada. La deduplicación exacta evita repetir ejecución en
condiciones idénticas; la similitud puede ayudar a elegir padres, no vetar una variante antes de medirla. Una diferencia
pequeña de código puede cambiar el mecanismo. Un juez de novedad es un perfil opcional cuyo coste y rechazos se registran.

## 8. Semillas y analogías sin convertirlas en requisitos

Fuentes admitidas: inicio del solicitante, historial autorizado, otros runs, programas generados de cero, rivales
públicos del mundo y conceptos de documentos o de investigaciones anteriores. Las baselines privadas del operador
no son semillas. Cada fuente conserva procedencia, permisos, hash y conocimiento previo de la tarea objetivo.

Los candidatos externos se materializan y reevalúan en el laboratorio de la rama; no se ordenan usando rendimientos
de otra máquina ni aceptaciones ciegas. Los veredictos previos no desaparecen de la historia de exposición del linaje
por ocultarlos al mutador. La evaluación final utiliza realizaciones nuevas respecto a esa exposición cuando se exija
generalización. Si no se puede garantizar, se informa; no se inventa independencia.

No es obligatorio crear una isla por run. La población se organiza para explorar, y mantiene una cuota de reinicios
sin heredar el programa actual. Esa cuota es una vía de búsqueda, no un control experimental independiente si comparte
información con el resto.

Una analogía aporta una relación a intentar trasladar. Puede acompañar una mutación o un inicio nuevo. Se conserva el
concepto, procedencia y correspondencia declarada con el destino. El código y las medidas dicen si fue útil; una
tabla de correspondencias convincente no valida la transferencia ni un juez la garantiza. La evidencia de origen
no se transfiere como evidencia del destino.

La biblioteca puede ser un artefacto o colección de documentos del investigador. No se introduce un servicio
obligatorio de conceptos. El investigador decide qué conclusiones incorporar, con estado y límites; una mejora de
rendimiento no se promociona automáticamente a «principio general» reutilizable.

## 9. Consolidación: entender lo necesario para seguir

La fase de búsqueda produce candidatos y un índice navegable. Al terminar o agotar su asignación, un investigador
asistido general recibe la pregunta, el corte del padre y acceso a candidatos, fallos, diferencias y medidas autorizadas.
**Ese run de consolidación es un hijo interno de la rama, no una delegación:** no pasa por `delegate`, no ocupa la plaza
de rama del solicitante ni la regla de no recursión, y no reserva aparte del fondo. Su coste entra en el `cost.total`
del supervisor (§3), dentro de la reserva protegida de consolidación (§12).
La evolución se importa mediante un adaptador de experiencia, no fingiendo que su base de datos ya es un diario asistido.

Su objetivo es hacer la entrega **utilizable**: reproducir lo relevante, detectar atajos o pérdidas, identificar qué
merece adoptarse y proponer el siguiente experimento. Puede explicar un mecanismo, pero no tiene que escribir una
teoría de cada candidato ni realizar una ablación ceremonial para entregar una solución útil.

Cuando una decisión dependa de una explicación —por ejemplo, generalizar fuera del rango medido— puede usar ablaciones,
trasplantes o pruebas diferenciadoras. Registra qué esperaba antes del contraste y qué observó. El resultado se acota
a esas condiciones; una descripción del mutador no es una prueba causal y una única ablación no explica todo el programa.

Legibilidad sigue siendo valor del proyecto: se entregan código, linaje, condiciones y explicaciones inspeccionables.
Si el programa sigue siendo difícil de entender, se dice y se conserva como candidato útil, no como solución ya
interpretada. Simplificarlo puede ser el próximo trabajo del padre. Añadir reglas en palabras que el código no usa
produce una explicación adjunta, no un predictor neurosimbólico por definición.

La consolidación no lanza evoluciones recursivas en esta entrega. Devuelve encargos sugeridos que el padre puede
convertir en otra delegación dentro de sus recursos. Si acaba sin llamadas disponibles, se entrega el índice mecánico
y los candidatos con estado `unreviewed`; no se oculta el trabajo ni se inventa una explicación.

## 10. Adaptación a mundos de leyes

Para artefactos mutan archivos; para leyes, un modelo ejecutable con contrato de entrada/salida. El perfil rápido puede
evolucionar `observations` y `output` sin llamadas a Jev. No se excluye una semilla que use reglas silenciosamente:
se rechaza como incompatible con ese perfil o se utiliza un perfil con reglas y coste declarado.

Si se ajustan constantes, el evaluador separa parámetros globales de estado inferido por episodio:

- Parámetros globales: ajustados sólo con datos de ajuste.
- Parámetros por objeto/episodio: inferidos exclusivamente del historial disponible al predecir.
- Resultado: calculado sobre observaciones posteriores que no participaron en esa inferencia.

El programa exportado lleva su procedimiento de inferencia y su coste. No se puntúa con masas obtenidas mirando todo
el episodio y luego se entrega un predictor que no puede obtenerlas. El optimizador numérico es parte versionada del
contrato, con dominio, límites e inicialización. Sus fallos se registran.

Los datos usados repetidamente para seleccionar son datos de búsqueda, aunque se llamen «selección». Se refrescan
cuando el laboratorio lo permite, y se mantienen contrastes adicionales para comprobar las mejoras seleccionadas.
Las realizaciones reservadas de aceptación siguen fuera del bucle. Se conserva información temporal y pertenencia de
episodios para impedir que ventanas solapadas se presenten como datos independientes.

En mundos externos, trabajar sólo sobre registros es un modo explícito `recorded_only`, no un laboratorio físico
supuestamente clonado. Requiere adaptador con herramientas limitadas y datos apartados para consolidación. Si faltan
datos o contraste posible, se informa. Una ablación del predictor prueba ese predictor; no demuestra por sí sola la
causa física de la dinámica. No se habilitan actuaciones externas por retirar el rechazo actual de delegación.

## 11. Medición práctica y paralelismo

Para seleccionar programas por tiempo se comparan con una referencia o padre medidos en condiciones comparables.
Se intercalan repeticiones y se conservan orden, máquina, concurrencia y variabilidad. No se confrontan ciegamente
puntuaciones de generaciones que utilizaron cargas o entornos diferentes.

El motor puede proponer y preparar varias candidatas a la vez, pero el perfil de rendimiento usa por defecto una cola
de evaluación serial por recurso de medida. Paralelizar benchmarks en la misma máquina puede seleccionar contención,
no mejores programas. Con recursos independientes se declara asignación y se confirma una élite antes de exportarla.

Medir crecimiento en un intervalo no prueba complejidad asintótica. El resultado indica tamaños, rango y distribución;
un programa cuadrático que mejora mucho sigue siendo útil, sin denominarlo subcuadrático por una pendiente local.

## 12. Recursos y ciclo de vida

Una sola rama y una sola reserva del fondo de delegación. Se divide inicialmente un 75 % de tokens para búsqueda y
un 25 % para consolidación, con mínimos explícitos de llamada y ejecución; configuración modificable por el operador.
La búsqueda no consume la reserva protegida de consolidación. Su remanente sí puede pasar a consolidación. Ninguna fase
usa más de la reserva total sin otra concesión explícita.

Límites independientes: tokens, intentos de propuesta/parche, evaluaciones de candidatos, ejecuciones primitivas,
segundos de máquina acumulados, tiempo de pared y trabajos simultáneos. Cada evaluación declara cuántas ejecuciones
reserva. Preparación de semillas, duplicados propuestos, errores, jueces, embeddings y ajustes numéricos consumen sus
recursos reales. No se llama barata a una fase por usar menos rondas.

Por llamada y ejecución se registra propietario, fase, modelo, consumo observado y desconocido. Se reservan recursos
antes de despachar trabajos concurrentes. La falta de usage no equivale a cero ni permite agotar la reserva protegida.
Los límites comprobados entre llamadas conservan el tratamiento de sobrepaso e incertidumbre del arnés.

Estados internos: `preparing`, `searching`, `consolidating`, `delivering`, con terminales `completed`, `failed`,
`cancelled`. El estado externo conserva el contrato de delegación. Agotar búsqueda permite consolidación parcial;
cancelar detiene ambas fases y el árbol de procesos, conserva candidatos y devuelve parciales. No arranca B después
de cancelar. El fin del padre aplica la política de cierre ya existente.

## 13. Registro y transición entre fases

Antes de lanzar se guardan solicitud, inicio, fuentes, perfil, límites y versión de motor. Cada intento registra entrada,
modelo, respuesta, cambios, padres, propuesta inválida si la hubo y consumo. Cada evaluación guarda programa ejecutado,
workloads, resultados, medidas, condiciones y revisión del archivo. Cada selección conserva criterio y estado de política.

La base del motor es un soporte, no la única autoridad de recursos o entrega. El diario de la rama conserva IDs estables
de operaciones y recibos; trabajos enviados sin resultado se reconcilian antes de repetirlos. No se supone que restaurar
una base de datos resuelva llamadas en vuelo o coste incierto.

`search_finished` sella el manifiesto de candidatos y datos con hash. `consolidation_requested` fija ID de hijo, entrada
y reserva antes de lanzarlo; se registra inicio y final. Al reanudar se recupera ese hijo, no se crea otro. La entrega
final tiene identidad única y se reconstruye sin leer un archivo que haya cambiado después del corte.

`lab pack` incluye programas completos, dependencias declaradas, datos autorizados, registros de inferencia, medidas,
archivo y versiones. `lab verify` reconstruye selección y entrega desde registros sin inferencia ni benchmarks nuevos.
Reejecutar mide de nuevo y puede variar; evolucionar otra vez es otro recorrido. Una descripción o hash sin contenido
recuperable no basta para adoptar, verificar o reproducir un candidato.

### 13.1 Continuar una búsqueda sin perder sus caminos

El manifiesto sellado `evolution-search@1` es el resultado importable de búsqueda. Contiene o referencia por contenido:

- Programas, dependencias, padres, raíces de linaje, intentos y diagnósticos, incluidos los retirados y duplicados.
- Evidencia con cargas, semillas, evaluador y entorno; validez de medidas, descriptores y comparador.
- Poblaciones, cola de admisión, archivo, cuotas consumidas, conjunto de hashes conocidos y cursores de selección.
- Ventanas y recuperaciones de atasco, estado aleatorio si el perfil lo usa, configuración y versión de política.
- Corte del diario, operaciones pendientes, coste observado o incierto, fuentes autorizadas y versión de formato.

`continue_from` abre **otra rama con otra reserva**, en el mismo mundo y objetivo compatible. El nuevo encargo puede
orientar la búsqueda y cambiar el modelo mutador, sin reescribir el trabajo anterior. La importación se registra con
hash de origen y correspondencia de IDs. No altera el manifiesto fuente, no vuelve a cobrar su inferencia y no atribuye
las medidas heredadas a ejecuciones nuevas. Su coste histórico sigue consultable, separado del gasto nuevo.

Se valida antes de conceder la rama: formato, permisos, contenido recuperable, contrato del artefacto y perfil de
selección. H1–H2 sólo continúan con la misma versión y configuración de política; cambiarla requiere una búsqueda
nueva con `start` y, si está habilitado, `seeds`. No hay una migración silenciosa que conceda otra vez todas las cuotas.
Los nuevos límites de recursos sí pueden ser distintos. Dos continuaciones son ramas independientes y siguen el
límite de concurrencia de la delegación.

Con evaluador, cargas y entorno compatibles se hereda la evidencia como histórica. Cambiar una condición que afecte
a las medidas las marca `stale`: no sirven para élites, archivo ni comparación actual hasta reevaluar. Se conserva
su contexto para interpretar los fallos; no se trata un error del entorno anterior como un hecho del actual. Los
candidatos activos afectados se reevaluan, por orden de admisión, antes de volver a seleccionarlos; esas ejecuciones
consumen la reserva nueva. Reevaluar no crea otro hash ni renueva cuotas. La consolidación confirma lo que exporta
según §11, también cuando heredó evidencia compatible.

Los cupos pendientes, cursores e historial se conservan. No es obligatorio que quede una cuota de desarrollo abierta:
las élites, el archivo y los reinicios siguen produciendo caminos. Un recurso incierto u operación pendiente se
reconcilia en la rama de origen antes de habilitar su continuación; no se clona una ejecución en vuelo.

Reanudar tras caída es otra operación: conserva ID de rama, reservas y trabajos ya despachados. Reconstruye el estado
desde el diario y recupera la transición pendiente, sin generar ni medir otra vez lo que ya tiene recibo. Ambas vías
comparten el formato de estado, pero no la identidad ni la liquidación de recursos.

## 14. Integración y ejecución de código

El launcher de la rama ejecuta un supervisor con dos fases, no dos delegaciones independientes.

**El primer backend es nativo, en TypeScript, dentro del arnés** (`lib/src/learn/evolve/`). No es un port de Shinka: es
la implementación de la política de esta spec. Shinka podría preservar las garantías del arnés mediante adaptación,
así que no es una imposibilidad técnica. **El motivo es el coste de integración:** ese trabajo de adaptación es
justamente el que se quiere evitar, porque integrar nuestra política y nuestras garantías es más sencillo en un motor
nativo. Lo que habría que adaptar:
- **Las llamadas al LLM deben pasar por el cliente del arnés:** registradas en el log de replay, reservadas del fondo,
  contabilizadas por fase y reconstruibles sin inferencia (§12, §13). Los clientes propios de Shinka (OpenAI, Gemini o
  CLIs) tendrían que redirigirse a un endpoint servido por el arnés.
- **La política de selección de esta spec difiere de la de Shinka por defecto:** sin rechazo por novedad con
  embeddings, sin prima de celda nueva, corrección como puerta, cola de evaluación serial y bandit opcional. Casi todo
  serían adaptadores que sustituyen lo nativo del motor.
- **Shinka guarda en su propia SQLite,** que tendría que quedar como soporte secundario del diario de la rama.
- **Es un paquete de pip, con herramientas pensadas para Unix.** El motor nativo no añade una dependencia operativa
  nueva. Los mundos sí pueden necesitar las suyas (Python, servicios externos), y eso no cambia.

El evaluador es `ArtifactWorld` (o el adaptador del mundo de leyes), llamado en proceso por el supervisor a través del
sandbox de procesos, nunca importando candidatas. Shinka puede añadirse después como backend opcional si un problema
medido lo justifica. Sus condiciones serían:
- llamar al LLM por un endpoint compatible con OpenAI servido por el arnés, que registra y contabiliza;
- un evaluador puente `lab evolve-eval`;
- su SQLite como soporte, nunca como autoridad.

La configuración distingue endpoint/modelo de mutación, consolidación y embeddings opcionales. No se presupone que
un servidor de chat ofrezca embeddings. Se validan capacidades antes de lanzar; el perfil inicial no los requiere.
Recomendaciones meta, filtros de novedad y operadores automáticos del motor se habilitan sólo si constan en el perfil.

El backend actual de procesos locales **no aísla archivos y red**. La integración lo declara mediante `isolated: false`;
un directorio nuevo no impide leer el evaluador. No se importan ni ejecutan candidatas en el proceso del supervisor.
El operador selecciona un entorno con permisos de SO limitados y sin acceso a credenciales o conjuntos reservados,
o acepta explícitamente el modo local de confianza, que no acredita esa frontera. No se exige Docker. Si un run exige
aislamiento efectivo y el backend no lo ofrece, se rechaza antes de consumir inferencia.

Las garantías del registro existen con el backend inicial. Que sea nativo no lo hace pequeño: se estima por sus
contratos (§12–§13), no por líneas.

## 15. Resultados e identidad

Se amplían resultados y trazas existentes: coste directo/delegado/total sin duplicación; desglose búsqueda/consolidación;
intentos y evaluaciones; candidatos retenidos y exportados; cambios de dirección; adopción y veredictos posteriores.
El trabajo de un resultado evolutivo se atribuye al conjunto de búsqueda, modelos, fuentes y revisión.

La identidad del generador incorpora perfil, modelos, feedback, operadores, archivo y selección, presupuestos, motor
y versiones. Fuentes de semillas y conceptos se identifican por contenido y procedencia; rutas operativas no cambian
identidad. Opciones del mundo, sondas y workloads se identifican como condición y realización sin confundirlas con
ajustes del generador. Cada rama conserva su perfil; cambiarlo entre búsquedas conserva la procedencia del trabajo
heredado y da otra identidad al generador.

La pregunta de utilidad es: **¿qué puede hacer ahora el investigador que antes no estaba consiguiendo?** Puede ser
resolver la tarea, obtener un candidato mejor, una vía concreta que desarrollar o descartar un supuesto con una prueba.
No se exige aceptación final y explicación causal completa para reconocer utilidad parcial; tampoco se presenta
diversidad de texto o de celdas como resolución del problema.

## 16. Entrega y pruebas que permiten usarlo

### H1. Motor y búsqueda ejecutable en artefactos

Motor nativo, perfil `balanced@1`, evaluador sobre `ArtifactWorld` con la calidad del objetivo de la tarea, registro,
límites, estado importable y exportación de programas. Un mutador por el cliente del arnés; intentos completos en
serie. Archivo opcional con descriptores declarados. Sin embeddings ni juez de novedad obligatorio.

La aceptación de H1 no requiere pagar inferencia. Un mutador simulado y medidas deterministas ejercitan la política
real; una tarea local pequeña comprueba por separado materialización, ejecución y uso de `judge`.

Pruebas obligatorias:

1. **Atravesar varios peldaños.** A produce B, B produce C y C produce D; B y C son correctos pero inferiores a A y sin
   `holds`. Sólo D mejora A. La selección real, sin inyectar padres desde el test, da desarrollo a B y C y encuentra D
   con recursos suficientes. Se comprueba también la retirada por cuota y por capacidad, sin prometer oportunidades
   ilimitadas a todos los candidatos.
2. **Separar corrección, calidad y aceptación.** Incorrectos rápidos no desplazan élites; pueden repararse dentro de
   su cuota. Corrección no comprobada no se toma por éxito. Una calidad ausente no expulsa del desarrollo a un programa
   cuya corrección sí se comprobó. Una reparación fallida, un duplicado o un nuevo nombre no renuevan cuotas.
3. **Reaccionar antes de evaluar.** Cinco respuestas duplicadas o inválidas activan los reinicios aun sin completar
   cinco evaluaciones. El contexto registrado no filtra el código dominante al reinicio. Fallos de transporte siguen
   la reconciliación, y los reinicios también terminan al agotar recursos.
4. **Usar el feedback y reconocer atasco.** El contexto siguiente contiene el diagnóstico que le corresponde. Dos
   ventanas sin progreso cambian la selección según §7.3; ruido, reevaluaciones y un cambio de orden sin la tolerancia
   requerida no inventan progreso. Se comprueba la precedencia entre las dos recuperaciones.
5. **Medir y archivar sin falsear el objetivo.** En crecimiento, seleccionar usa la pendiente, no `wall_ms`. Intervalos
   y valores ausentes conservan su estado. El archivo retiene y recorre alternativas según §6.2, sin prima histórica
   que impida que un descendiente mejor sustituya al primero de su celda. Funciona también sin descriptores.
6. **Reconstruir y continuar.** Replay de selección, contextos, cuotas y entrega idéntico sin llamar al modelo ni medir.
   Importar el corte continúa sus cursores y alternativas; no regala cuotas ni cobra consumo anterior. Evidencia
   incompatible exige reevaluación, contenido ausente se rechaza y dos continuaciones no modifican su origen.
7. **Cerrar a cualquier altura.** Límites, cancelación y caídas antes/después de respuesta, evaluación y selección dejan
   estado recuperable. Una respuesta incierta no se despacha otra vez. Lo ejecutado parcialmente y su coste quedan
   visibles aunque todavía no haya un candidato exportable.

### 16.1 H1 implementada (25/10/2026)

En `lib/src/learn/evolve/`, con sus pruebas en `lib/test/evolve.test.ts` (las siete obligatorias, el límite de contexto
y el evaluador de artefactos sobre un `ArtifactWorld` real):
- `policy.ts`: la política `balanced@1`, pura y reconstruible desde eventos (§6–§7).
- `engine.ts`: el motor. Cada efecto tiene ID e intención registrada antes del despacho; hay replay sin modelo ni
  medidas, reanudación sin repetir lo que tiene recibo, y manifiesto sellado `evolution-search@1` con continuación.
- `mutator.ts`: el mutador por el `ChatClient` del arnés.
- `artifacts.ts`: el evaluador sobre `ArtifactWorld`. Sólo usa laboratorios, y su calidad es la de `judge`.

**Un añadido al contrato del evaluador:** `adopt(hash, files)`. Un evaluador juzga contenido, nunca un hash que da la
casualidad de que conoce. Al continuar una búsqueda sellada en otra rama, su store no tiene los programas importados:
el motor se los pasa con su contenido, y el evaluador comprueba que ese contenido da el hash.

Los límites de segundos de máquina y de tiempo de pared (§12) se añadieron después, con H2 (§16.3).

### H2. Delegación y entrega utilizable

Integrar solicitud y capacidades, reserva existente, corte, supervisor, adaptador de experiencia, consolidación
asistida y `continue_from`. La configuración del operador habilita explícitamente el modo y sus límites. La solicitud
no permite ampliar permisos, workloads ni recursos por encima de esa configuración.

Pruebas obligatorias:

1. El padre recibe un `research_result`, lee el recorrido, importa y ejecuta un candidato materializado. Importar no
   equivale a aceptarlo y el mensaje no cuenta como ayuda del entorno.
2. Caídas antes/después de `search_finished`, `consolidation_requested`, final de consolidación y entrega no duplican
   procesos, gasto ni mensajes. Cancelar durante búsqueda no arranca consolidación.
3. La liquidación agrega ambas fases y conserva gasto incierto. Búsqueda parcial o consolidación fallida devuelven
   candidatos e índice con su estado; no dependen de que exista un cuaderno convencional.
4. El padre continúa una búsqueda sellada mediante nueva delegación y reserva; `lab pack` y `lab verify` recuperan
   también el material heredado. Se mantienen las pruebas existentes de delegación, permisos y registro append-only.

### 16.2 H2 implementada (25/10/2026)

Pruebas en `lib/test/evolve-delegation.test.ts`. La primera es de integración completa con el laboratorio de artefactos:
el padre delega, recibe el resultado una vez, adopta un candidato por su contenido y lo ejecuta, y el paquete se verifica
offline. Las demás cubren caídas en cada transición, cancelación, liquidación con consolidación fallida o búsqueda
parcial, y `continue_from` con empaquetado.

- **Operador:** `--delegation-evolve N` habilita el modo, con un máximo de N evaluaciones por rama;
  `--delegation-evolve-workloads` fija las cargas de cada familia de laboratorio. Sólo hay evaluador en el mundo de
  artefactos; en otro mundo se rechaza antes de reservar nada.
- **`delegate` con `mode: "evolve"`** (en `lib/src/learn/assisted/delegation.ts`):
  - un modo desconocido, o `start` junto con `continue_from`, se rechaza;
  - `start` es una versión del solicitante, o su última versión, y se pasa por su contenido. El senior la obtiene
    reconstruyendo el mundo desde el diario del junior;
  - `continue_from` es el hash o el ID de una búsqueda sellada de una rama propia que ya terminó.

  La concesión reparte los tokens: 75 % para la búsqueda y 25 % protegido para la consolidación.
- **El supervisor** (`lib/src/runtime/evolve-branch.ts`, proceso propio con `scripts/run-evolve.ts`, lanzado por
  `startEvolveAt`) escribe el formato común de ciclo de vida: diario con `end`, status con latido y pid, inbox y un
  finding cuyo total suma las dos fases. Además:
  - al reanudar, una búsqueda que terminó no se repite, y una consolidación que empezó se reanuda en lugar de lanzarse
    otra vez;
  - lo exportado (élites y candidatos en desarrollo, nunca el inicio) se confirma con realizaciones nuevas.
- **La consolidación** es un run del investigador asistido. Lee la búsqueda con `--evolution-search` como experiencia
  `search`, a través de su propio adaptador (`lib/src/learn/evolve/experience.ts`), con los tipos `candidates`,
  `attempts` y `decisions`.
- **El informe evolutivo** (adaptador por modo) lleva:
  - los candidatos enteros, con sus medidas y su confirmación;
  - el inicio aparte;
  - cómo adoptar un candidato;
  - la consolidación, o `unreviewed` con su motivo;
  - la búsqueda sellada para continuarla;
  - el coste por fase.
- **`read` sobre la rama** usa ese mismo adaptador.

### 16.3 Cierre de H1–H2 (25/10/2026)

Repasada la spec contra el código, se cerraron los huecos que quedaban. Las pruebas están en
`lib/test/evolve-delegation.test.ts` (H2.1, H2.3 y H2.5):
1. **Las capacidades no implementadas se rechazan (§3, H4).** `seeds`, `analogies`, `profile`, `descriptors`, `models`
   y otras se rechazan antes de gastar nada, en los dos modos. En el modo evolutivo, un campo desconocido, también dentro
   de `budget`, se rechaza con la lista de los admitidos.
2. **Límites de recursos (§12):**
   - `--delegation-evolve-machine-seconds` acota la suma de lo que tardan sus evaluaciones; se registra por evaluación y
     el replay usa lo registrado;
   - `--delegation-evolve-wall-seconds` cuenta desde el inicio de la rama, también tras reanudarla: la búsqueda se para
     ahí y la consolidación recibe el resto como `--max-minutes`.

   La verificación no usa el reloj.
3. **`lab verify` reconstruye cada búsqueda (§13).** `lib/src/learn/evolve/verify.ts` rehace los programas por su
   contenido y sirve del registro cada respuesta y cada medida. Después compara el estado reconstruido con el que se
   selló: candidatos, selección, cuotas y cursores. Una búsqueda continuada se reconstruye con la que continúa, que tiene
   que estar en el paquete. El resultado va en `verification.searches`.
4. **K1 y trazas (§15).** `cost.tokens.evolutionary` desglosa, sin contarlo dos veces porque ya está en el coste
   delegado:
   - la búsqueda y la consolidación;
   - intentos, evaluaciones y segundos de máquina;
   - candidatos exportados, adoptados y aceptados por el mundo.

   Las trazas cuentan las ramas evolutivas y los candidatos adoptados. Un candidato cuenta como adoptado cuando el padre
   crea, por contenido, una versión igual a uno que se exportó.
5. **Identidad (§15).** La configuración del modo lleva el perfil (`balanced@1`) y el motor (`EVOLVE_ENGINE`,
   `native@1`), así que forman parte del generador.
6. **Aislamiento exigido (§14).** Con `--delegation-evolve-isolated`, una rama en un sandbox que no aísla se rechaza
   antes de reservar nada. `ArtifactWorld.isolated` dice si el sandbox aísla.
7. **`refs` (§3).** Llegan al texto de la consolidación.

### 16.4 H4: semillas (25/10/2026)

Es la primera extensión de H4 (§8). Lo habilita el operador:
- `--delegation-evolve-seeds N`: como mucho N semillas por rama;
- `--delegation-evolve-seed-sources`: las fuentes autorizadas, entre `own`, `searches` y `experience` (por defecto,
  `own,searches`).

Una petición evolutiva admite `"seeds": [...]`, con IDs del catálogo del run:
- `artifact:<versión>`: una versión del solicitante;
- `search:<hash sellado>#candidate:<programa>`: un candidato de una búsqueda sellada de una rama propia;
- `exp:<etiqueta>#artifact:<versión>`: una versión de un run que se lee como experiencia. Su mundo se reconstruye desde
  su diario.

Cada semilla se resuelve por contenido al aceptar la petición, con su fuente y con la declaración de que su fuente
conocía la tarea. Si una no se puede tomar (ID desconocido, fuente no autorizada, demasiadas o inexistente), se rechaza
la petición entera antes de reservar nada: nunca se omite una semilla en silencio.

En la rama, cada semilla:
- se adopta por contenido (si no da su hash, se rechaza con `seed_refused` y la búsqueda sigue sin ella);
- se registra como raíz de su propio linaje, con origen `seed:<id>`;
- se vuelve a medir en el laboratorio de la rama: lo que puntuó en otro sitio no es evidencia aquí.

La verificación offline reconstruye también las semillas, a partir de `search_started`. Las analogías, otros modelos o
políticas, el paralelismo y el perfil de leyes siguen rechazándose como no implementados. Las pruebas están en
`lib/test/evolve-delegation.test.ts` (H4).

### 16.5 Revisión externa de H1–H2 y semillas, conciliada (25/10/2026)

Nueve fallos, corregidos con una prueba de regresión cada uno, sobre el caso que se reprodujo
(`lib/test/evolve-review.test.ts`):
1. **Reanudar con el plazo vencido perdía trabajo registrado.** Ahora todo lo que el registro tiene se recupera antes de
   decidir nada nuevo: la cancelación y el plazo sólo detienen trabajo nuevo. Al reanudar sobre su propio fichero, lo
   que ya contiene no se reescribe ni se recorta; sólo se añade lo que viene después.
2. **`lab verify` ignoraba las búsquedas.** Ahora el resultado del comando cuenta `searches[].holds`, y muestra cada
   búsqueda con su motivo. `verifySearch` comprueba primero el sello y luego compara el manifiesto entero (estado,
   coste, heredado, parada).
3. **Los límites no cubrían toda la rama:**
   - las confirmaciones comparten el presupuesto de evaluaciones y el plazo: de lo concedido, una cuarta parte (al menos
     una, desde dos) queda protegida para confirmar, y la búsqueda y sus confirmaciones nunca pasan de lo concedido;
   - un candidato fuera de presupuesto se entrega como no confirmado, con su motivo;
   - pasado el plazo no hay consolidación (`consolidation_skipped`, entrega `unreviewed`), y la consolidación recibe
     exactamente lo que queda, sin un minuto mínimo.
4. **El gasto desconocido se liberaba.** Un finding que declara gasto desconocido se liquida reteniendo la concesión
   como incierta, con lo observado aparte. Lo mismo para un run con `usage_unknown`.
5. **Se descartaba la evidencia.** Cada evaluación guarda en su evento las ejecuciones y medidas de las que salió su
   veredicto, nunca en el estado. La verificación, con la tarea (tomada de la petición de la rama, `.evolve.json`),
   vuelve a juzgar cada evaluación desde su evidencia (`rejudge`, con `judge`) y exige la calidad y corrección
   registradas.
6. **La parada no llegaba a la consolidación.** Ahora `consolidate` recibe la señal del supervisor, y `run-evolve.ts`
   la pasa a `runLaboratory`.
7. **El contrato de un reinicio estaba incompleto.** El contrato lleva `io`: el comando, las entradas tal como se dan,
   las salidas, y un workload de exploración con lo que responde la referencia. Nunca lleva código.
8. **Una cadena de reparaciones renovaba plaza.** Un programa hecho por una reparación nunca recibe una plaza propia, ni
   después de agotar su cuota (`repair_exhausted`).
9. **Al continuar se perdían élites.** Marcar la evidencia como obsoleta conserva las élites: son lo primero que se
   vuelve a medir, y sólo sus medidas nuevas deciden si siguen.

### 16.6 Segunda revisión de los mismos cambios, conciliada (25/10/2026)

Cinco fallos más, con su prueba de regresión en `lib/test/evolve-review.test.ts`:
1. **Una consolidación omitida rompía la entrega.** Ahora una consolidación sin diario (omitida por el plazo) se entrega
   como `unreviewed`, con su motivo.
2. **Una llamada sin respuesta se liquidaba como gasto cero.** Ahora la llamada cuya respuesta no se conoce (al reanudar
   tras una caída, o al cancelar en curso) cuenta como gasto desconocido, y la rama retiene su concesión como incierta.
3. **Se rechazaban búsquedas válidas cerradas por tiempo o cancelación.** Una verificación que agota el registro donde
   la búsqueda terminó reproduce la causa de cierre registrada, porque el reloj y el solicitante no los decide el
   registro.
4. **Se perdían élites pendientes de reevaluación.** La cola de reevaluación (`reevaluate`) se fija al marcar la
   evidencia como obsoleta (élites primero) y se recorre en ese orden, aunque la selección se recalcule entretanto.
5. **El redondeo podía desactivar el límite de la consolidación.** Nunca se le da un límite de cero minutos, que para el
   laboratorio significa sin límite. Con menos de una centésima de minuto no se inicia ni se reanuda la consolidación.

### H3. Uso real en ThreeSum

Ejecutar `threesum-subquadratic@1` desde su base cuadrática, con historial autorizado y configuración explícita en el
batch del run. El encargo busca una mejora o una vía alternativa sin indicar algoritmos. Este paso verifica que la
integración deja al investigador trabajo utilizable.

Examinar qué padres recibieron trabajo, qué feedback cambió las propuestas, qué produjeron los reinicios y qué candidato
o descarte permite una siguiente acción del padre. Si sólo aparecen variaciones equivalentes, distinguir si falla
la generación, el reparto de oportunidades, la medición o la ejecución. Que se cumpla el protocolo no acredita que
la búsqueda haya abierto otra dirección. Los parámetros operativos y el gasto del piloto pertenecen al run.

### H4. Extensiones con sus propios adaptadores

Semillas externas y analogías, otros modelos o políticas, paralelismo de propuestas y mundos de leyes se habilitan
mediante capacidades explícitas. Las solicitudes de una capacidad no implementada se rechazan antes de consumir
inferencia; nunca se aceptan para luego ignorarlas. El esquema común no implica soporte de todos los mundos.

El perfil de leyes debe comprobar que el ajuste no lee el futuro y que lo exportado reproduce el procedimiento de
inferencia evaluado. `recorded_only` requiere el adaptador limitado de §10. Un backend externo cumple los mismos
contratos de llamadas, recursos y registro. Ninguna de estas extensiones bloquea H1–H2.

## 17. Límites de integración para desarrollo

La implementación separa decisiones de búsqueda de efectos externos para poder verificar el recorrido:

| Pieza | Responsabilidad |
|---|---|
| Política y estado de búsqueda | Admisión, cuotas, elección de padres/operadores, archivo, atasco y siguiente acción; reconstruibles desde eventos |
| Mutador | Construir el contexto de §7.2, llamar por el cliente existente y devolver propuesta con respuesta y consumo registrables |
| Evaluador del mundo | Validar y materializar, ejecutar sólo cargas autorizadas, obtener corrección/calidad/descriptores y exportar el programa ejecutado |
| Supervisor de rama | Reservar mediante la contabilidad existente, despachar efectos, registrar recibos, reconciliar y coordinar búsqueda/consolidación |
| Adaptador de experiencia y resultado | Exponer recorrido y candidatos a `read`, consolidación y padre; empaquetar el corte importable y la entrega |

Cada efecto tiene ID estable y una intención registrada antes del despacho. La política consume su resultado una sola
vez. Los cursores, cuotas y decisiones se actualizan por esa transición, no por volver a leer un recibo al reanudar.
Los paquetes incluyen todo contenido necesario para reconstruirla; una cache o índice puede regenerarse desde ellos.

El perfil queda fijado al abrir la rama: configuración, comparador, descriptores, límites de contexto y capacidades.
Sus decisiones adaptativas previstas, como reaccionar al atasco, son estado del mismo perfil. Reconfigurar la política
abre otra búsqueda; el desarrollador no introduce valores implícitos dependientes del estado local de la máquina.

**H1 y H2 quedan especificadas para implementar, en ese orden.** H3 necesita ambas funcionando. Los nombres internos
de tipos y archivos quedan a criterio del desarrollador; las transiciones, información observable, permisos y pruebas
anteriores son el contrato. El investigador general conserva su método y decide si usa y adopta esta búsqueda.
