# SPEC · Metapolítica de aprendizaje: un investigador que aprende a mejorarse

Estado (29/10/2026): **fase A implementada (MA1–MA7), sin ejecuciones reales todavía**. **MA1 implementado salvo su prueba real** (`lib/src/junior`, guía en
`lib/examples/junior.setup.md`): paquete, sesiones con recibos, verificador, intermediario y comprobación de la máquina,
probados con un servidor simulado. Falta ejecutar el driver real de Qwenputer en la máquina del junior. **MA2
implementado** (`lib/src/junior/competence.ts`, `jobs.ts`, `trials.ts`, `probes.ts`, `evaluate.ts`, mundo
`junior-competence@1` en `lib/src/worlds/junior`): manifiesto, medidas y `paired-cases@1`, libro de trabajos, ensayos de
M2 con el junior como System 2, sondas por corte de la cola de repetición y comprobadas por el propio arnés, línea base y
mundo con `change`/`run`. Falta su primera línea base real. **MA3 implementado** (`lib/src/junior/memory.ts`): la
memoria inicial como palanca (`memory/<nombre>`, escrita por el propio junior en una sesión y aceptada sólo si su
referencia lee exactamente lo pedido), `publish_memory` desde las sesiones de investigaciones de desarrollo, la memoria
legible por `render` y la promoción sin entrenar. **MA4 implementado** (`lib/src/junior/distill.ts`): el maestro en un
corte, con su memoria servida por el simulador de referencia en una copia (`POST /memory`, traducción `teacher-memory-json@1`
registrada), el junior en el mismo corte, la aceptación de §8.1 por el comprobador fijado antes (verified, unverified,
rejected), datasets por contenido con su solapamiento con los grupos de selección, y los actos `distill` y `dataset`.
Las comparaciones semánticas por continuaciones y las demostraciones con juicio quedan para otra condición. **MA5
implementado** (`lib/src/junior/train.ts`, `junior_train.py`): receta `junior-recipe@1` rechazada si toca el circuito,
entrenamiento como trabajo recuperable en su propio proceso (capacidad medida antes, puntos de control, adaptador por hash
sólo al terminar), rechazo por solapamiento con los grupos de selección, validez del circuito antes de evaluar (suite que
exige ejercitar cálculo, escritura, lectura, borrado y memoria restaurada sin discrepancias, y parámetros del circuito
iguales a los de la base) y el acto `train`. La divergencia KL como diagnóstico queda pendiente. **MA6 implementado** (`lib/src/junior/confirm.ts`, `lab junior
confirm`): el servicio del operador importa los paquetes congelados comprobando cada fichero por hash en su propio
almacén, los evalúa con su propio servidor en los casos reservados de su manifiesto, guarda el informe completo del
operador y publica sólo un resumen (veredicto, componentes que mejoran o empeoran, lo que el candidato debe a otros); cada
resumen expone sus casos y, pasado el tope, el servicio deja de confirmar en ellos. El investigador lee los resúmenes con el
acto `confirmations`. **MA7 implementado** (`lib/src/junior/learning-policy.ts`, `lab junior policy|policies`):
`learning-policy@1` validado (procedimientos por SHA-256, parámetros declarados, `scope`), expandido para M1 con
`expansion@1` (rechazado si excede el consejo máximo, nunca recortado), su hash de ejecución, catálogo por mundo, el
producto de una investigación de mejora leído de su diario y la comparación de investigaciones de mejora por pares; una
política expandida aconseja en una corrida real del mundo del junior. La equivalencia entre snapshot neuronal y gemelo se
comprueba ejecutando el circuito (su ejecutor, como `storecheck`) sobre el flujo registrado, con el checkpoint y una GPU;
sin ellos la verificación queda incompleta. Fase A completa en código: faltan las ejecuciones reales. MA1–MA7 definen ejecución, evaluación,
destilación, entrenamiento y método reutilizable. El mecanismo de relevo de fase B queda definido y desactivado hasta
que el operador configure su batería y umbrales a partir de la evidencia de fase A, antes de evaluarlos. Este documento
fija los contratos para desarrollo; los valores de cada experimento se declaran en su manifiesto antes de ejecutarlo.

Amplía [SPEC-METAPOLITICA-INVESTIGACION](SPEC-METAPOLITICA-INVESTIGACION.md) y su
[catálogo](CATALOGO-METAPOLITICAS-INVESTIGACION.md). Usa el [mundo de artefactos](SPEC-MUNDO-ARTEFACTOS.md), los ensayos
interiores de M2, la [vista de escalada](SPEC-VISTA-ESCALADA.md), el [investigador asistido](SPEC-INVESTIGADOR-ASISTIDO.md)
y el inventario de [riesgo de modelos](SPEC-RIESGO-MODELOS.md).

## 1. La idea

**Un modelo pequeño que aprende, con método, cómo mejorarse a sí mismo.** El arnés le da mundos donde ejercitarse y
medirse. Para mejorar dispone de varias palancas: su procedimiento, su memoria, sus pesos y sus instrumentos. Aprender
cuándo usar cada una y con qué evidencia es la **metapolítica de aprendizaje**, y es el resultado que se quiere
conservar.

La metapolítica de investigación aprende un procedimiento con los pesos del junior fijos (su §1). Ésta levanta esa
restricción, como anticipaba su §14, y lleva la automejora de su §15 a todas las palancas. Se conservan dos resultados:
el junior producido (`junior-package@1`, §4) y el procedimiento para producir mejoras (`learning-policy@1`, §14.1).
Una trayectoria de entrenamiento documentada es experiencia para ese procedimiento; su utilidad se mide al aplicarlo
en otra investigación de mejora, no por el mero hecho de haber obtenido un junior mejor.

**Por qué en dos fases.** Los runs anteriores con Qwen encontraron dificultades para cumplir lo que el arnés exige.
Eso motiva un arranque asistido; la línea base de §6.2 medirá las dificultades del modelo elegido, sin deducirlas de
su tamaño ni del resultado de otro modelo. Por eso:

- **Fase A, arranque:** un modelo fuerte mejora al modelo pequeño hasta que rinde en el arnés. Es un mundo de artefactos
  cuyo artefacto es el propio junior.
- **Fase B, relevo:** superado el contrato de relevo configurado según §14, el modelo pequeño toma el control de su propio
  aprendizaje en ese mismo mundo, y el modelo fuerte pasa a ser una palanca más.

## 2. El modelo: Qwenputer

[Qwenputer](https://github.com/divagr18/qwenputer) es Qwen3.5-4B con un ordenador RISC-V compilado en capas delante de
las de Qwen. Su variante [Filesystem](https://huggingface.co/divagr1925/Qwen3.5-4B-Qwenputer-Filesystem) añade un sistema
de archivos operado por ese circuito. **El circuito está compilado en pesos; los archivos viven en el estado recurrente
DeltaNet.** Escribir un archivo cambia estado, no entrena parámetros. Lo que importa aquí:

- **Memoria propia.** Herramientas `put`, `append`, `get`, `list` y `delete`, ejecutadas por las capas compiladas, nunca
  por un programa externo.
  - Hasta 512 archivos y unos 53.000 tokens, con nombres planos y un directorio por hash; no hay carpetas.
  - Se guarda al acabar una sesión y se carga en la siguiente (`memory.npz`, `save_store()`/`load_store()`).
  - Ese guardado no representa toda una sesión de inferencia: el firmware y la reconstrucción del contexto requieren
    su propio contrato (§5). Véase el [driver de referencia](https://github.com/divagr18/qwenputer/blob/rv-store/experimental/riscv/chipformer/rv/chat.py).
- **Cada operación es visible.** El ordenador escribe su ejecución como tokens de traza en la salida, y de ellos se lee
  qué se escribió o borró.
- **Pesos exactos.** Las capas compiladas no se aprenden: un compilador las calcula, y su exactitud se verifica
  reproduciendo la traza contra un modelo de referencia. Cualquier reentrenamiento tiene que preservarla.
- **Recursos de partida.** Las cifras citadas para la variante Filesystem son 22,3 GB en bf16 y unos 18 GB de GPU.
  MA1 verifica la configuración concreta en una RTX 3090, incluyendo contexto, cachés y ejecución del circuito; esas
  cifras no constituyen una garantía de memoria disponible para entrenar.
- **Una advertencia de su ficha.** En una conversación larga responde desde su contexto y no consulta la memoria. El
  hábito de consultarla hay que inducirlo.

El diseño no depende de Qwenputer. Cualquier modelo con memoria propia y pesos entrenables puede ocupar su lugar, como
otra condición.

## 3. Principios

- **P1. La medida está fuera de su alcance.** La confirmación (casos, semillas y evaluador) no vive en la máquina del
  modelo. El acceso de superusuario no debe permitir leer sus datos reservados ni modificar el criterio con el que se
  mide una versión. En su máquina sólo hay casos de desarrollo (§9).
- **P2. Dentro del mundo, sólo fuentes propias.** El investigador aprende las leyes de un mundo de lo que el mundo le
  responde, como siempre. Las trazas de otro modelo nunca son evidencia del mundo: son material del nivel exterior.
- **P3. Lo ajeno se declara.** Lo destilado de otro modelo, la ayuda del operador y el conocimiento de dominio quedan en
  la procedencia de cada versión. Una mejora destilada se presenta como destilada.
- **P4. Cada versión es otro junior.** Pesos, memoria inicial, prompt, decodificación y entorno de ejecución semántico
  forman su identidad (§4). Un resultado de una versión no se importa a otra sin volver a medirlo. Una sesión conserva
  además su identidad y la cadena de estados de memoria.
- **P5. El ordenador compilado no se rompe.** Ninguna versión que pierda su exactitud o la de su memoria es válida, por
  mucho que mejore en lo demás.
- **P6. La métrica es la montaña.** Cada peldaño de competencia es una métrica que mejora o empeora, y se ve en la vista
  de escalada. El método se lee al lado.
- **P7. Todo se reconstruye.** Cada cambio, conjunto de datos, entrenamiento y medida deja un registro y sus productos
  conservados. Se reconstruyen el historial, las decisiones y los resultados sin red ni entrenamiento nuevo; no se
  promete regenerar pesos o respuestas idénticos volviendo a ejecutar el aprendizaje.

## 4. El artefacto: un junior empaquetado

Formato `junior-package@1`. Una versión es todo lo que define al junior:

| Parte | Qué es | Cómo se guarda |
| --- | --- | --- |
| Modelo base | El checkpoint de partida (Qwenputer Filesystem) | Por hash, fuera del almacén de artefactos |
| Adaptador | LoRA sobre las capas de Qwen, o ninguno | Por hash, fuera del almacén; el artefacto guarda su manifiesto |
| Prompt de arranque | Lo que el junior recibe al empezar, además del prompt del arnés | Texto, en el artefacto |
| Memoria inicial | El estado del sistema de archivos con el que arranca cada run | `memory.npz` por hash y su gemelo de referencia (el dispositivo del verificador, §5.2) por hash: los dos o ninguno; su contenido legible en el artefacto |
| Decodificación | Temperatura, límites, formato forzado si se usa | En el artefacto |
| Ejecución | Firmware, tokenizer, plantilla de chat, driver, configuración del circuito, precisión y cuantización | Versiones y contenido por hash; opciones efectivas en el manifiesto |
| Procedencia | Padres, motivo de cada cambio, datos y entrenamientos que lo produjeron | En el artefacto |

- **Versionado** con el almacén de artefactos existente: contenido por hash, padres y vuelta atrás.
- **Los binarios grandes** (adaptadores y memorias) se guardan por hash en un almacén aparte, y el artefacto sólo los
  referencia, para no meterlos en el registro.
- **Su hash de ejecución** identifica al junior en los ensayos (P4): todas las partes que pueden cambiar su respuesta,
  incluidas las referencias a binarios y procedimientos activos. Rutas, fechas y notas de procedencia quedan fuera;
  el registro de procedencia conserva su propia identidad. Mismo nombre de modelo con otro contenido no es la misma versión.
- **Paquete cerrado:** exportarlo incluye sus dependencias o un almacén local verificable que las contenga. Una URL o
  un hash sin los bytes correspondientes no permite declarar reconstruible el paquete. El contenido legible de una
  memoria se deriva de su snapshot y debe coincidir con él.
- Los binarios y manifiestos de ejecución nuevos usan SHA-256 completo. Los manifiestos se serializan como JSON con
  claves ordenadas y valores efectivos, incluidos los valores por defecto; los binarios se verifican sobre sus bytes.
  El ID del almacén de artefactos identifica la edición; el hash de ejecución identifica lo que se sirve y evalúa.
  Una etiqueta de modelo, una ruta o un hash abreviado de la interfaz no sustituye esa comprobación.

## 5. El servidor del junior

El arnés conserva el formato de conversación compatible con OpenAI. Un servidor local alrededor del driver de
Qwenputer y un adaptador de sesión en el cliente añaden la gestión explícita del estado. Compatibilidad de conversación
no implica que el cliente actual ya pueda recuperar un servidor con memoria mutable.

- carga el modelo base, el adaptador y la decodificación de la versión pedida;
- carga el firmware del ordenador y la memoria inicial de la versión al empezar cada run; para una sonda `cut` o una
  destilación, abre la sesión con el snapshot explícito del corte y registra ese origen;
- guarda la memoria tras cada respuesta, en una copia propia del run, nunca sobre la memoria inicial;
- devuelve el texto del modelo y un recibo con sus operaciones de memoria, estados y consumo; conserva también los
  tokens de traza necesarios para verificarlas.

### 5.1 Una pregunta, una transición publicada

El adaptador ofrece apertura, consulta de recibos, restauración y cierre de sesión, además de generar respuestas:

- La apertura fija `session_id`, `run_id`, hash del junior y snapshot inicial. Dos ensayos tienen sesiones y memorias
  separadas, aunque compartan servidor, GPU o mensajes idénticos.
- Cada pregunta lleva un `request_id` estable, el hash del contenido efectivo de la petición y el hash del estado
  anterior esperado. La misma identidad con otro contenido o estado se rechaza; no se adivina la sesión por el prompt.
- La inferencia trabaja sobre una copia privada del estado. Respuesta, traza, estado posterior y consumo se conservan
  antes de publicar de forma atómica el recibo y la nueva referencia al estado de la sesión. Una respuesta completa
  con formato inválido sigue siendo una respuesta registrada; un aborto sin respuesta completa no publica sus escrituras.
- Repetir una petición ya publicada devuelve el mismo recibo, sin inferencia ni escrituras nuevas. Las peticiones de
  una sesión se serializan; otra con un estado anterior obsoleto se rechaza.
- Tras una desconexión se consulta el recibo. Una petición pendiente no se relanza a ciegas. Si el servidor puede
  acreditar que no publicó nada y que el trabajador anterior ya no puede publicar, restaura el estado anterior y
  registra el fallo; un nuevo intento tiene identidad propia. Un trabajador invalidado no puede publicar aunque
  termine después. El consumo no conocido permanece reservado como incierto, aunque se descarte el estado de trabajo.
- El recibo terminal distingue `answered`, `limit_reached`, `cancelled` e `infra_failed`. Alcanzar el límite declarado
  de tokens, tiempo o pasos del circuito conserva el prefijo emitido, el motivo y el consumo como `limit_reached`;
  mantiene la memoria anterior si no hubo una respuesta completa. Ese límite no se convierte en fallo del proveedor
  ni dispara un reintento de transporte. Una pregunta correctiva posterior es otra pregunta, con su propio coste y
  resultado; no borra el fallo anterior. La clasificación de su medida sigue §6.3.

### 5.2 Reproducir y volver a continuar

El diario conserva, por pregunta, versión, sesión, petición, contenido efectivo, recibo, estado anterior y posterior,
traza y consumo. Los snapshots y las dependencias de §4 acompañan al paquete. El hash del estado posterior de una
respuesta debe coincidir con el anterior de la siguiente.

`lab verify` reproduce la conversación desde el registro, comprueba esa cadena y aplica las operaciones de memoria
en un verificador de referencia inicializado con el snapshot correcto. Contrasta el estado reconstruido con el
snapshot posterior; guardar dos hashes no sustituye esa comprobación. No pide al LLM respuestas nuevas.

Al reanudar en vivo, las respuestas históricas se sirven sin contactar al modelo. Antes de la primera pregunta nueva,
el adaptador restaura explícitamente la última memoria publicada, el firmware y el contexto efectivo. La configuración
de ejecución declara qué otros estados necesita y cómo se reconstruyen; se rechaza una recuperación incompleta.
Si abre otra sesión para continuar, la enlaza con el último recibo de la anterior sin cambiar las identidades históricas;
resuelve primero cualquier petición pendiente, antes de decidir desde qué estado continúa.
El verificador debe soportar memoria precargada, no sólo conversaciones iniciadas con archivos vacíos.

**Dónde vive el verificador.** No se reimplementa en TypeScript la semántica del sistema de archivos de Qwenputer. El
verificador de referencia y el simulador del maestro (§8) son un solo programa: el de referencia del proyecto
Qwenputer, en Python, fijado por hash entre las dependencias de ejecución del paquete (§4). `lab verify` lo lanza como
proceso local, sin red, le pasa snapshot, operaciones y traza, y compara su respuesta. El arnés comprueba hashes,
cadena de estados y recibos. Si el paquete no incluye ese programa, el paquete no es verificable.

### 5.3 Aprender entre runs sin mezclar ensayos

El cuaderno y la memoria selectiva del arnés siguen perteneciendo al run. La memoria del modelo puede transmitir
experiencia a otra investigación, mediante una publicación explícita:

- Cada investigación independiente y cada sonda `start` parten de la memoria inicial congelada del paquete. Una sonda
  `cut` parte del snapshot común declarado en §6.4. Su memoria final se conserva como
  resultado, sin sustituir la inicial ni convertirse automáticamente en el arranque del siguiente ensayo.
- Incorporar memoria de desarrollo crea otro `junior-package@1`, con sus runs de origen y contenido declarado. La
  memoria de confirmación no se incorpora al aprendizaje mientras esos casos sigan reservados.
- Si el encargo es aprender a lo largo de una secuencia de mundos, el manifiesto fija la secuencia, su orden y su
  estado inicial. La unidad evaluada es la secuencia completa; sus runs no se cuentan como ensayos independientes.
- La memoria de trabajo del investigador exterior puede evolucionar en su investigación. Las versiones que entrega
  a los ensayos interiores permanecen congeladas y aisladas de esa memoria.

## 6. Fase A: el mundo de la competencia

Un mundo de artefactos (`junior-competence@1`) cuyo artefacto es el junior empaquetado (§4).

- **Su investigador es el modelo fuerte,** configurable como el de cualquier investigador, con su propia memoria
  selectiva, notas y documentos.
- **Su check son ensayos interiores (M2):** cada versión se ejecuta como junior sobre casos fijados por el operador, y el
  resultado se lee de los registros de esos runs.
  - Se reutilizan las reservas, el libro de ensayos, la reconciliación y la verificación de M2. Hace falta un adaptador
    de candidato y de lanzamiento: `Trials.run` hoy recibe una política, no un paquete de junior.
  - El adaptador materializa y verifica el paquete antes de abrir la sesión. El ID del ensayo incluye condición fija,
    hash de ejecución del junior, caso, repetición y estado inicial. El hash pedido debe coincidir con el servido.
  - La identidad del evaluador fija mundos, métricas, particiones, herramientas y recursos. El junior variable es la
    identidad del candidato, no una modificación silenciosa de ese evaluador. Si lleva una política de orientación,
    ésta se fija como condición o se declara parte del paquete variable.
- **Sus actos** son los del mundo de artefactos, más los de §7 y §8. Cada cambio declara su porqué y las creencias en
  que se apoya, como en 3SUM.

### 6.1 La escalera de competencias

La escalera mide lo que el arnés exige, de lo básico a lo difícil. Así la montaña tiene pendiente desde el principio, y
no sólo «no resuelve»:

| Peldaño | Métrica | De dónde sale |
| --- | --- | --- |
| 1. Protocolo | Proporción de respuestas aceptadas a la primera, sin errores de formato | `proposal_refused`, rechazos de formato |
| 2. Peticiones | Proporción de peticiones bien formadas, por tipo (`view`, `act`, `measure`, `table`…) | Errores de cada resultado de investigación |
| 3. Reglas del arnés | Proporción de actos sin rechazo por regla (cambios con su porqué, nada tras un acto, límites respetados) | Rechazos con su motivo |
| 4. Modelo comprobable | Proporción de propuestas que compilan y llegan a check | `proposal`, `check` |
| 5. Método | Rondas con una hipótesis puesta a prueba; resultados que llevan a la siguiente idea; experimentos que se usan | Trazas K4, informes del Judge separados de los hechos |
| 6. Mundos | Puntos exactos de sus checks y aceptaciones, por mundo y nivel | La métrica de cada mundo (vista de escalada §3) |

- **Cada medida se declara** con unidad, dirección, casos aplicables, denominador, objetivo, tolerancia y fuente. Un
  peldaño puede tener varias medidas: el número de peldaño no es una puntuación ni obliga a un orden de aprendizaje.
- **La vista conserva medidas originales y el comparador recibe déficits normalizados**, según §6.3. Los puntos de
  distintos mundos y los juicios del Judge no se pasan directamente al comparador como si fueran la misma magnitud.
- **Los casos son de dos tipos,** declarados en el manifiesto:
  - **Investigaciones:** runs completos en mundos de distinta naturaleza y dificultad: `cells` en varios niveles, la
    rejilla, `orbit`, un mundo de artefactos y `plates`.
  - **Sondas de competencia (§6.4):** un corte fijado en el que se exige una competencia concreta. Dan a los peldaños
    1 a 4 oportunidades comparables entre versiones.
- **Hechos y juicios, separados.** Los peldaños 1 a 4 y 6 son hechos del registro. El peldaño 5 combina hechos y juicios
  del Judge, que quedan marcados como tales. Sólo entran en la selección las medidas con oportunidades fijadas (§6.3):
  las de las sondas y las de los resultados de cada mundo. Las tasas sobre los actos libres de una investigación se
  muestran como diagnóstico.

### 6.2 La línea base

Antes de cualquier cambio se mide Qwenputer tal cual sobre toda la escalera, para obtener la taxonomía real de sus
errores. Primero se conservan sus investigaciones sin modificarlo; de ellas y del corpus de desarrollo se preparan y
particionan las sondas de §6.4. Se congela el manifiesto y se completa la línea base ejecutando esas sondas con el mismo
paquete original. Así los cortes no dependen de una línea base de sondas que aún no existe. Si existen, se leen con el
mismo instrumento los runs de Qwen 3.8-27B, para saber en qué peldaño se quedaron. Ningún cambio del junior se propone
antes de completar esta línea base.

### 6.3 Medir progreso y seleccionar

El manifiesto de `junior-competence@1` fija el contrato de medida antes de la búsqueda. Para cada componente incluye
su ID, peldaño y mundo o nivel cuando corresponda, extractor versionado, casos y repeticiones, unidad, dirección,
valor objetivo `target`, referencia desfavorable `bad` y tolerancia de regresión en su unidad original. Las referencias
son constantes del encargo, no el mejor y peor candidato de la población. `target` y `bad` deben ser finitos, distintos y
coherentes con la dirección. Cambiar el contrato crea otra condición y obliga a reevaluar.

Para un valor observado `x` en un ensayo, el déficit es:

```text
d(x) = clamp((target - x) / (target - bad), 0, 1)
```

Por ejemplo, una proporción de aciertos con objetivo 1 y referencia 0 da `1 - x`; un número de errores con objetivo
0 y referencia 10 da `x / 10`, acotado a [0, 1]. Se conserva también `x`, incluso cuando el déficit se satura. Cumplir
un objetivo deja de competir por excederlo mientras quedan otros por alcanzar; es una decisión de selección declarada.

Cada componente de calidad es el déficit medio: primero entre las repeticiones de cada caso y después entre sus
casos fijados. No se agregan oportunidades sueltas en una sola proporción: el caso es la unidad. Para que eso no
dé más peso a unos casos que a otros, los casos de un componente se construyen iguales:

- **Peldaños 1 a 4, desde sondas.**
  - Hay un componente por peldaño y modo de estado (`start` o `cut`, §6.4); el peldaño 2 tiene uno por cada tipo de
    petición exigido (`view`, `act`, `measure`, `table`…) y modo, porque un tipo que falla siempre no debe quedar tapado
    por los demás. El manifiesto fija los componentes y casos aplicables antes de la búsqueda.
  - Todas las sondas de un componente piden el mismo número de respuestas. Con decodificación determinista es una;
    si el paquete muestrea, cuatro.
  - Cada mundo aporta el mismo número de sondas a cada componente que le aplica. Así ningún mundo domina el componente
    por tener más cortes.
- **Peldaño 5:** diagnóstico en la primera condición; no forma componentes (ver abajo).
- **Peldaño 6:** un componente por mundo y nivel; cada caso es un run con su resultado exacto en el check del mundo,
  repetido el mismo número de veces en todos. No se mezclan mundos en un componente: sus puntos no son la misma
  magnitud.

El motor existente compara el vector de componentes del peor al mejor, con menor déficit como mejor resultado. No se
suman componentes en una nota; se conserva el vector con sus nombres.
La incertidumbre y las regresiones se calculan por caso y ensayo sobre las medidas originales, no contando filas o
tokens de un mismo run como observaciones independientes. El manifiesto fija el procedimiento y sus márgenes.

La elección de medidas evita recompensar la ausencia de actividad:

- Las pruebas de competencia fijan oportunidades de demostrar lo exigido: una pregunta que debe responderse, una
  petición de un tipo requerido o una propuesta comprobable. No responder o no producir lo requerido cuenta como
  fallo de esa oportunidad. No se consigue un 100 % de peticiones válidas haciendo cero peticiones.
- Las tasas sobre actos elegidos libremente durante una investigación se muestran con su cobertura. Sin oportunidades
  comparables, son diagnósticos y no componentes de selección. No usar una herramienta opcional no demuestra un fallo.
- La no aplicabilidad de un componente a un caso se declara en el manifiesto, nunca por la candidata después de verlo.
- Un fallo del proveedor, una cancelación o un ensayo que no pudo financiarse deja la evaluación incompleta, sin
  calidad comparable ni entrada en élites. Los errores observados del junior sí se miden. Se conservan los parciales
  y se recuperan sin repetir trabajo ya registrado.
- Agotar los límites normales del ensayo es un final medido: el extractor lee lo conseguido y cuenta como fallidas
  las oportunidades exigidas que no se completaron. En una sonda `limit_reached` sin respuesta válida cuenta como
  fallo. Una cancelación externa o una avería del servicio sigue siendo incompleta; la clasificación se decide por
  el recibo del ejecutor, no por lo que alegue la candidata.
- Un extractor sin resultado verificable, con denominador cero en un componente aplicable o con un valor no finito
  no produce calidad: deja un error de evaluación. Una salida inválida del junior, en cambio, se registra como fallo
  mediante el comprobador de esa competencia. Nunca se sustituye un dato ausente por cero déficit.

El peldaño de método se registra siempre con hechos y juicios separados. En la primera condición sus juicios son
diagnósticos: no se recompensa la redacción que convenza al Judge. Incluirlos en selección requiere otra condición
que fije rúbrica, Judge, evidencia observable y tratamiento de desacuerdos; no cambia el significado de los hechos.

### 6.4 Sondas de competencia

Una sonda pide una respuesta bajo una consigna explícita y comprueba una competencia concreta. Reutiliza la
reconstrucción de cortes de §8. El manifiesto fija su ID, run y pregunta de origen, hash del corte, modo de estado
(`start` o `cut`), componente, competencia, consigna visible, comprobador ejecutable y versión, y recursos.
La temperatura, el formato y demás opciones de decodificación proceden del paquete candidato; las semillas son las
realizaciones del manifiesto (§6.5) y los límites quedan acotados por sus recursos. El número de respuestas sigue
la regla de §6.3: una con decodificación determinista y cuatro si el paquete muestrea.

**Qué se restaura y qué aporta el candidato.** Los dos modos son parte de la identidad de la sonda:

| Parte | `start`: competencia al arrancar | `cut`: competencia en una situación ya vivida |
| --- | --- | --- |
| Momento | Primera pregunta del run, antes de cualquier respuesta del junior | Una pregunta fijada de un run de desarrollo |
| Mundo, herramientas, cuaderno y recursos | Los del corte inicial, iguales para todos los candidatos | Los del corte elegido, iguales para todos los candidatos |
| Memoria del modelo | Copia de la memoria inicial del paquete candidato | Copia del snapshot del corte; no se mezcla con la memoria inicial candidata |
| Conversación | Contexto inicial autorizado, sin respuestas previas del junior | Prefijo autorizado anterior a la respuesta elegida; nunca la continuación |
| Prompt de arranque, pesos, adaptador, driver y decodificación | Los del paquete candidato | Los del paquete candidato |

El constructor conserva el prompt fijo del arnés y sustituye exclusivamente el bloque de arranque del junior original
por el del candidato, una sola vez y en la misma posición. Identifica ese bloque por su procedencia, no por una
sustitución de texto. Si el original no tenía bloque, usa el punto de inserción del prompt de arranque definido por el
arnés. Los mensajes históricos restantes no se reescriben. Un corte cuyo bloque de arranque no pueda separarse o cuyo
estado no pueda reconstruirse se rechaza al preparar el manifiesto, antes de evaluar candidatos. El candidato
reconstruye sus propias cachés a partir de los mensajes efectivos; no carga cachés neuronales del modelo de origen.
La precarga del contexto no reejecuta acciones ni escrituras históricas: al comenzar la respuesta, la memoria debe
coincidir con el snapshot de apertura declarado.
La compatibilidad de snapshots de memoria forma parte del contrato de ejecución de la condición.

La batería incluye sondas `start` para medir las palancas de arranque. Las sondas `cut` miden qué hace una versión en
una situación común con memoria fijada: no acreditan una mejora de su memoria inicial ni que hubiese llegado por sí
sola a esa situación. La memoria inicial se evalúa con `start` y con las investigaciones completas. Los resultados de
ambos modos quedan en componentes distintos, con sus nombres y medidas originales; no se mezclan sus denominadores.

El recibo registra el hash del paquete, el modo, el prompt y mensajes efectivos, la decodificación y el snapshot
realmente usados. En `cut`, el estado de apertura es el snapshot declarado por la condición; el paquete original y su
hash no se modifican. Cada repetición abre una sesión independiente desde ese mismo estado de prueba. Ninguna respuesta
de una repetición se entrega a otra. Los errores de infraestructura siguen §6.3 y no cuentan como fallos del junior.

**La tarea es visible.** Antes de responder, el junior recibe la consigna como mensaje del evaluador, mediante el
canal de mensajes existente, después del prefijo y antes de la respuesta que se puntuará. Su texto y posición forman
parte de la identidad de la sonda y del registro. Por ejemplo: «Emite una única petición `act` válida para este mundo,
respetando el protocolo y los recursos disponibles». Se comunica la competencia exigida, sin aportar una respuesta
de ejemplo ni información restringida. El mensaje no cambia las reglas ni habilita actos que el corte prohíba.

El comprobador acepta cualquier respuesta que satisfaga esa consigna y el contrato real: parser, petición ejecutada
en una copia del mundo o compilación de la propuesta, según la competencia. No exige la estrategia, los argumentos
concretos ni la redacción que prefiera el maestro. Una respuesta vacía o de otro tipo falla sólo cuando contradice lo
solicitado visiblemente. La preparación comprueba que existen herramientas, recursos e información accesible suficientes
para cumplir la consigna; si ésta exige un acto prohibido en el corte, la sonda es inválida y no se ejecuta. Una
competencia que requiera varias preguntas se mide mediante una investigación completa, no como una sonda de una respuesta.

**Partición y comparación común.** Los cortes proceden sólo de desarrollo. Antes de entrenar se separan los grupos
destinados a construir ejemplos de los destinados a sondas de selección. El grupo es el linaje del run de origen:
continuaciones, cortes adyacentes y copias derivadas permanecen juntos. Una sonda puede proceder de un error de la línea
base, y entonces se marca como reparación de un error conocido; la batería incluye también situaciones que no se
eligieron por un fallo. La selección sigue siendo desarrollo visible, no sustituye la confirmación reservada de §9.

- Una condición tiene la misma lista de sondas, pesos por caso y regla de repeticiones para todos sus candidatos.
  No se retiran pruebas sólo para una descendencia ni se marca una sonda como no aplicable porque esa candidata la haya
  entrenado. La media por caso conserva su peso aunque cambie el número de repeticiones previsto por la decodificación.
- Antes de entrenar, el control del dataset comprueba la procedencia de sus ejemplos, incluidos los transformados o
  destilados. Si comparte un grupo con las sondas de selección vigentes, el entrenamiento se rechaza con ese motivo.
  El ejemplo se conserva como material de investigación; no se borra ni se presenta como fallo de competencia.
- Para convertir ese grupo en material de entrenamiento, el operador publica primero otra condición que lo retire
  de selección para todos. Debe mantener las cuotas por mundo y sondas en cada componente exigido, añadiendo grupos
  disjuntos cuando hagan falta. Se recalculan la referencia y todos los candidatos que vuelvan a competir bajo el nuevo
  manifiesto; ninguna calidad o promoción se hereda del anterior. Sólo se reutiliza evidencia individual del mismo
  candidato y sonda cuyos inputs efectivos, comprobador y recursos no hayan cambiado, con referencias explícitas a sus
  recibos; las pruebas nuevas se ejecutan. La comparación queda incompleta hasta reunir toda la evidencia requerida
  por la nueva condición.
- Si se descubre después que una candidata o un antecesor se entrenó con un grupo de selección, sus medidas se marcan
  como contaminadas para esa condición y se retira su elegibilidad para selección y promoción. El paquete, las medidas
  históricas y el hallazgo se conservan; volver a compararla exige la condición común nueva. No se corrige su puntuación
  eliminando sólo sus respuestas a ese grupo.

**Coste.** Cada repetición paga una pregunta del junior, incluidas sus operaciones internas de memoria o cálculo,
la reconstrucción y la comprobación. Las investigaciones completas siguen midiendo los peldaños 5 y 6. La ejecución
de la consigna sirve para comprobar la respuesta y no abre una continuación adicional del investigador.

### 6.5 Manifiesto e identidad de la evaluación

`junior-competence-manifest@1` es configuración del operador. Se valida y congela antes de buscar; la candidata no lo
edita. La primera implementación rechaza configuraciones incompletas antes de reservar inferencia:

| Campo | Contenido obligatorio |
| --- | --- |
| `reference` | Hash del paquete de referencia |
| `cases` | IDs únicos, mundo y realización, partición, grupo de procedencia, componente, corte y consigna en sondas, recursos y regla de repeticiones |
| `metrics` | Extractor versionado, unidad, dirección, `target`, `bad`, casos aplicables y agregación de §6.3 |
| `execution` | Versiones del arnés y comprobadores, formatos de snapshot admitidos, herramientas y configuración efectiva del Judge y del maestro cuando intervengan |
| `sampling` | Semillas de mundo e inferencia por caso y repetición; la candidata no las elige |
| `promotion` | Componentes protegidos, tolerancias y procedimiento ejecutable versionado para decidir mejora, incertidumbre y regresión sobre evidencia completa |
| `limits` | Topes por trabajo y bolsas de §13, incluidos pasos del circuito y tiempos de espera y ejecución |

La configuración de muestreo fija realizaciones, no temperatura ni formato forzado: esas palancas siguen en el
paquete. Cada repetición muestreada recibe una semilla distinta, fijada antes de comparar y compartida entre
candidatos. Un backend que no pueda aplicarla no sirve para esa condición. El recibo conserva la semilla efectiva;
fijarla no promete identidad numérica entre runtimes distintos. La regla una/cuatro se conserva. Los límites efectivos
son el mínimo entre los solicitados por el paquete y los permitidos por el caso; ambos valores quedan en el recibo.
La candidata no aumenta la reserva por declarar un tope mayor. Esta limitación explícita no es una opción ignorada.

Las medidas de la línea base se vinculan después al hash del manifiesto; no forman parte del contenido que las
identifica. La identidad del ensayo incluye manifiesto, paquete, caso, repetición y estado de apertura efectivos. El evaluador
conserva tanto la configuración solicitada como la resuelta; una opción ignorada o un backend incompatible se detecta
antes del ensayo. La promoción devuelve `promoted`, `not_promoted` o `inconclusive`, con los componentes y evidencias
que la justifican. El procedimiento no consulta modelos: se reproduce desde las medidas conservadas. El manifiesto
forma parte del paquete de reproducción, salvo los datos de confirmación reservados al operador.

**Procedimiento de promoción por defecto (`paired-cases@1`).** Es el que implementa MA2; otro procedimiento es otra
condición. Para cada componente se emparejan los casos de referencia y candidata, y se toma la diferencia de déficits
por caso, `Δ = d_ref − d_cand` (positiva si la candidata mejora):

- **Regresión.** Un componente protegido con media de `Δ` por debajo de `−tolerancia` da `not_promoted`.
- **Mejora.** Un componente mejora si la media de `Δ` es positiva y una prueba de permutación pareada unilateral (cambio
  de signo por caso) da `p ≤ 0,05`. La prueba es exacta hasta 20 casos; por encima usa 10.000 permutaciones con semilla
  fija en el manifiesto. La corrección de Holm se aplica sobre los componentes de selección.
- **Veredicto.** Sin regresión y con al menos un componente que mejora: `promoted`. Sin regresión y sin mejora
  significativa: `inconclusive`. Con evidencia incompleta, siempre `inconclusive`.

El manifiesto puede cambiar `α`, el número de permutaciones y las tolerancias; no el procedimiento.

## 7. Las palancas de la fase A

De más barata a más cara. El investigador elige cuáles usar, y cada uso queda en la procedencia:

1. **Prompt de arranque:** un cambio de texto, sin entrenar nada.
2. **Memoria inicial:** archivos escritos en la memoria del junior antes de empezar (métodos, recordatorios del
   protocolo). Se cargan como estado, no como prompt.
3. **Decodificación:** ajustes, y formato forzado si el servidor lo admite. Un formato forzado es una ayuda del arnés y
   se declara como tal: mide lo que el modelo hace con esa ayuda, no sin ella.
4. **Destilación desde un corte** (§8): datos de entrenamiento construidos donde el junior se equivoca.
5. **LoRA:** un entrenamiento sobre un conjunto de datos declarado, que produce un adaptador nuevo y una versión nueva.

### 7.1 Actos y trabajos del mundo

Se amplía el adaptador de laboratorio sobre el almacén de artefactos; no se fuerza un entrenamiento a pasar por el
sandbox de scripts de `artifacts@1`. Los actos conservan el porqué del cambio y usan estas operaciones:

| Operación | Entradas y resultado |
| --- | --- |
| `change` | Padre y parche del paquete; produce otra versión y valida sus referencias |
| `run` | Paquete y casos de desarrollo del manifiesto; produce recibos y medidas, parciales o completos |
| `distill` | Corte de desarrollo, paquete, maestro y criterio de aceptación; produce ejemplos de §8.1 y sus evidencias |
| `train` | Paquete padre, dataset y receta; produce adaptador y un paquete hijo, sin promoverlo |
| `publish_memory` | Paquete padre y recibo de una sesión de desarrollo; copia su memoria final a otro paquete, con procedencia |
| `cancel` | ID de un trabajo propio pendiente; solicita su parada y conserva lo ejecutado |

`view` consulta paquetes, datasets, recibos y estado de trabajos; `measure` y `table` leen sus resultados autorizados.
La confirmación sigue siendo una operación del evaluador externo. Ni `run` ni `distill` aceptan IDs de confirmación.

Los trabajos largos responden con `job_id` y publican su resultado como episodio cuando termina. El ejecutor conserva
los estados `queued`, `running`, `completed`, `failed`, `cancelled` y `uncertain`, junto a entradas por hash, reserva,
consumo, productos y motivo. El arnés asigna `operation_id` a la solicitud antes de lanzarla; repetirla devuelve el
mismo trabajo, y reutilizar ese ID con otras entradas se rechaza. Consultar o recuperar un resultado no vuelve a cobrarlo.
`completed` indica que terminó la operación, no que el junior acertó o que merece promoción; el veredicto va en su resultado.
Cancelar no declara terminado un trabajador que aún puede publicar: hasta reconciliarlo permanece en curso o incierto,
con su reserva. No se abre un segundo trabajo para sustituirlo mientras el primero pueda seguir ejecutándose.
Al cerrar el run padre se solicita la parada de sus trabajos pendientes y se concilian sus recibos; los que no puedan
conciliarse conservan su reserva incierta y quedan visibles al operador. No continúan gastando con un fondo nuevo implícito.

`lab verify` lee estos recibos y reproduce su incorporación al run sin lanzar trabajos. El diario del run referencia
el libro de trabajos y sus productos; no aparece otra autoridad que decida resultados o promociones. MA2 entrega
`change` y `run`, MA3 `publish_memory`, MA4 `distill` y MA5 `train`; consulta, cancelación y recuperación acompañan a cada
operación desde su primera entrega.

## 8. Destilación desde un corte

Comparar trayectorias completas de los dos modelos dice poco: divergen enseguida y no localizan el error. En su lugar,
se compara **desde el mismo estado**:

1. Se fija un corte anterior a una respuesta del junior: ID de pregunta, mensajes efectivos, estado del mundo,
   herramientas disponibles, cuaderno, memoria del modelo y recursos restantes. Todo procede de un caso de desarrollo.
2. Se reconstruye el corte con respuestas y acciones registradas. Se abren copias aisladas para el junior y el maestro:
   no leen la continuación original ni se afectan entre sí.
3. El maestro recibe la misma información accesible y herramientas de semántica equivalente, incluida la posibilidad
   de consultar la memoria que el junior podía consultar. No recibe de oficio todo su contenido privado. El adaptador
   puede traducir el formato de conversación de cada proveedor; registra esa traducción. No se pretende igualar los
   estados neuronales de modelos diferentes.

   El maestro no puede ejecutar un sistema de archivos que vive en los pesos del junior. Sus `put`, `append`, `get`,
   `list`, `delete` y `calc` los atiende el simulador de referencia de §5.2, sobre una copia del estado de memoria del
   corte, con la misma semántica y los mismos límites (512 archivos). Cada llamada y su respuesta quedan
   en el registro del corte. Lo que escribe el maestro sólo existe en su copia.
4. Se comparan las respuestas con el criterio fijado antes de pedir al maestro. Se registra el resultado incluso si
   el maestro falla o no mejora. La aceptación y el uso para entrenamiento siguen §8.1.

Se aprovecha el replay existente, pero el relevo en una pregunta arbitraria, la restauración de memoria y las copias
del mundo son trabajo de MA2 (para las sondas) y MA4. No se presume que continuar un run completo ya implemente esas
operaciones. Si un mundo no permite reconstruir un corte con los efectos externos necesarios, ese corte no se ofrece
para esta modalidad.

**Reglas de la destilación:**

- **Sólo casos de desarrollo.** El modelo fuerte nunca ve los casos, semillas ni realizaciones de confirmación (P1).
- **Nunca lo restringido:** ni datos privados de validación, ni lugares a ciegas, ni `hidden_from_the_learner`, ni
  veredictos que el junior no recibió. Un veredicto ya comunicado al junior sí pertenece a su vista autorizada.
- **Ejemplos con procedencia:** modelo fuerte, versión del junior, run, corte, y si el ejemplo corrige un error o sólo
  muestra otra decisión.
- **Un conjunto de datos es un artefacto:** contenido por hash, con su lista de ejemplos y su procedencia. Un
  entrenamiento lo cita por su hash.
- **Errores, primero de los hechos:** formato, peticiones rechazadas, reglas incumplidas y competencias explícitamente
  solicitadas que no consigue demostrar. No usar una herramienta opcional no es un error. Los juicios semánticos
  (una hipótesis mal elegida, un experimento que no discrimina) se marcan
  como juicios del Judge o del modelo fuerte.

### 8.1 Qué ejemplo se acepta y para qué

El criterio pertenece al encargo de destilación, no al maestro. Distingue cuatro estados:

| Estado | Evidencia | Uso |
| --- | --- | --- |
| `verified` | Una comprobación ejecutable satisfecha, con su alcance declarado | Objetivo supervisado para esa competencia |
| `demonstration` | Respuesta válida del maestro y juicio explícito sobre su conveniencia, sin prueba suficiente de superioridad | Demostración declarada, sólo si la receta de entrenamiento la admite |
| `unverified` | Propuesta pendiente, comparación inconclusa o comprobación no disponible | Material para investigar; no objetivo de entrenamiento en esta entrega |
| `rejected` | Viola el contrato o falla la comprobación exigida | Diagnóstico; no respuesta correcta que imitar |

Corregir sintaxis se comprueba con el parser real; corregir una petición, ejecutándola en la copia del mundo. Eso
acredita sintaxis o validez de petición, no una hipótesis ni su utilidad. Para afirmar que una decisión semántica es
mejor se fija un criterio observable y un horizonte, y se contrastan continuaciones desde el mismo corte, con recursos
comparables y la misma política de aleatoriedad del mundo. Si el resultado no discrimina, permanece como demostración
o propuesta; la opinión del maestro por sí sola no convierte el ejemplo en `verified`.

Cada ejemplo guarda entrada exacta, respuesta y tramo que se entrenará, estado de aceptación, competencia acreditada,
comprobador y versión, evidencias, presupuesto y procedencia. Un dataset puede mezclar competencias, pero su manifiesto
declara qué estados admite y sus proporciones. Por defecto sólo usa `verified`; una mezcla con `demonstration` es otra
receta explícita, no una colección presentada como respuestas verificadas. Las respuestas visibles de herramientas
quedan como contexto con su autoría y fuera de la pérdida de decisiones del LLM. Los tokens internos del circuito que
el driver oculta a las capas de Qwen permanecen en el registro de ejecución; no se introducen como texto de entrenamiento.

## 9. Medir sin poder tocar la medida

- **Desarrollo:** casos en la máquina del junior. Guían la búsqueda y su resultado es visible para el investigador.
- **Confirmación:** casos, semillas y evaluador fijos, fuera de su máquina. Los ejecuta el operador, o un servicio que
  recibe una versión congelada y la materializa en un entorno controlado, sin depender de un servidor modificable por
  el candidato. El operador recibe veredicto y registros completos. El junior sólo observa lo que el protocolo del
  mundo le entrega; no accede al banco de casos ni al criterio privado. El investigador exterior recibe únicamente
  el resumen de confirmación autorizado, sin herramientas para consultar sus trazas o memorias.
- **Un caso de confirmación usado para desarrollar** pasa a ser de desarrollo, y se necesita otra confirmación, como en
  la metapolítica de investigación (§9).
- **Transferencia:** se reservan mundos completos no expuestos durante el desarrollo, al maestro ni al junior. Se
  registra el conocimiento previo declarado; no se presupone desconocimiento de dominios presentes en el preentrenamiento.
  La transferencia aporta evidencia de generalización, no identifica por sí sola el mecanismo aprendido.

## 10. Validez, desarrollo y promoción

Son decisiones distintas y quedan registradas como tales:

1. **Validez para ejecutar.** El paquete está completo, cumple el contrato y conserva la exactitud del ordenador y la
   memoria. Se comprueba antes de ensayos costosos. La suite fija ejercita cálculo, escrituras, lecturas, borrado,
   guardado y restauración con memoria precargada y casos límite. No basta con cero discrepancias en una traza que no
   ejercitó el circuito. Un fallo impide ejecutarla como versión válida; el candidato y el diagnóstico permanecen
   disponibles para reparación.
2. **Desarrollo.** Una candidata válida puede conservarse y producir descendientes aunque aún sea peor, no mejore o
   pierda alguna capacidad. Se reutilizan las cuotas, reparación, diversidad y límites de la búsqueda existente.
   Una evaluación incompleta no la acredita como élite; tampoco se borra lo que ya se investigó sobre ella.
3. **Promoción.** Sustituir la referencia exige una evaluación completa bajo la misma condición, una mejora que
   supere el criterio y la incertidumbre fijados, y ausencia de regresión fuera de tolerancia en las capacidades
   protegidas. El manifiesto identifica esas capacidades, la referencia y los márgenes antes de comparar. Una mejora
   local de desarrollo puede ser provisional; anunciarla como confirmada o usarla para el relevo requiere §9.

**Conservación de capacidad.** Se mide con pruebas funcionales de retención, fijadas antes de entrenar y distintas de
los ejemplos usados para ajustar pesos. Pueden incluir capacidades ajenas al problema que se está mejorando. La
divergencia KL respecto a la base, con corpus, dirección y configuración declarados, es un diagnóstico de cambio de
distribución. No demuestra retención de capacidad ni es una puerta universal: aprender el comportamiento deseado
puede requerir separarse de la base. Una KL grande motiva inspección, no descarta por sí sola la candidata.

Las comparaciones de promoción conservan las medidas originales por competencia y mundo: mejorar el vector ordenado
no autoriza a ocultar una regresión concreta. Si no hay evidencia suficiente, la promoción queda inconclusa y se
mantiene la referencia; la candidata puede seguir desarrollándose con el presupuesto disponible.

## 11. Reentrenar sin romper el ordenador

- **Se entrena Qwen, nunca el ordenador.** MA5 implementa LoRA sobre las capas de Qwen del modelo combinado, con las
  capas compiladas y sus cabezas DeltaNet congeladas. La receta enumera los módulos entrenables y rechaza cualquier
  intersección con el circuito. Entrenar la base y recompilarla encima es otra receta; no es una dependencia de MA5
  ni un cambio automático si falla LoRA.

  La validez de §10 decide. Se fija la lista exacta de módulos y parámetros entrenables; congelar el
  circuito incluye conservar sus parámetros, conexiones y precisión efectiva. QLoRA no cuantiza por defecto las capas
  compiladas ni altera sus tablas o rutas compartidas. Cambiar esas partes exige volver a acreditar su exactitud.
- **Recursos:** dos RTX 3090, con una asignación prevista a ensayos y otra a entrenamiento. La primera receta utiliza
  LoRA; si no cabe, se prueba QLoRA sólo sobre Qwen y se registra como otra receta, preservando el circuito. La prueba
  de capacidad mide memoria máxima con las longitudes, precisión y lotes efectivos. Si ninguna cabe, el trabajo queda
  rechazado por recursos con su diagnóstico, sin cambiar silenciosamente el modelo o el contexto. No se deduce
  capacidad para entrenar de la memoria ocupada al inferir ni se tratan dos GPU como memoria unificada.
- **Quién usa cada GPU.** Toda inferencia del junior (ensayos, sondas, el lado del junior en una destilación desde un
  corte, la suite de validez) va a la GPU de inferencia, en una cola única que respeta las sesiones de §5.1. La GPU de
  entrenamiento sólo entrena. Si un trabajo de inferencia y uno de entrenamiento piden la misma GPU, espera el que llegó
  después: nunca se reparte una GPU a medias sin declararlo. Cada trabajo registra en qué GPU corrió y cuánto la ocupó.
  El tiempo de cola se registra aparte del de ejecución. Una cola que vence antes de ejecutar no es un fallo de
  competencia. El servidor libera el turno al terminar la respuesta; no retiene la GPU mientras el investigador
  espera una herramienta o un ensayo hijo. Cambiar de paquete conserva primero las sesiones y descarga el anterior
  si hace falta memoria: no supone que quepan dos versiones residentes.
- **Un entrenamiento es un acto del mundo:** conjunto de datos por hash, hiperparámetros, semilla, versión del código de
  entrenamiento, duración y recursos. Su resultado es el adaptador por hash y su registro. Volver a entrenar no se
  promete idéntico; el registro sí lo es.
- La receta declara también tokenizer, plantilla, máscara de pérdida, módulos objetivo y mezcla de estados de §8.1.
  Se registra la intención y se reservan recursos antes de lanzar el trabajo; un reintento consulta su recibo y sus
  checkpoints. Un entrenamiento incompleto conserva su gasto y productos parciales, sin publicarse como adaptador
  terminado. Verificarlo comprueba procedencia e integridad del producto conservado; no certifica que repetir la
  optimización produzca los mismos pesos.

## 12. La máquina

El modelo trabaja en una máquina propia, con superusuario. Para que un error suyo no pueda borrar lo que importa:

- **Copias fuera de la máquina** de registros, artefactos, adaptadores y memorias, a medida que se escriben.
- **Instantáneas del sistema de archivos,** para volver a un estado anterior.
- **Sin claves del operador** en la máquina. Las llamadas al modelo fuerte y al Judge pasan por un intermediario del
  operador que pone sus propios límites.
- **Salida de red limitada** a lo que necesite.
- **Límites de horas de GPU, disco y tokens,** que el intermediario y la máquina aplican, no el modelo.
- **Aprobación del operador** para adoptar una versión como base de la siguiente fase y para cualquier cambio de la
  confirmación.

Nada de esto requiere Docker.

**Qué es código y qué es montaje.** El intermediario de proveedores es código del arnés y lo entrega MA1. Corre fuera
de la máquina del junior, en el mismo equipo del operador que la confirmación de MA6. Guarda las claves, aplica las
bolsas de §13 y publica en ese equipo su libro de consumo. Copias, instantáneas, red y cuotas de disco son montaje del
operador. MA1 entrega una guía de montaje y una comprobación que se ejecuta antes de cada investigación y se niega a
empezar si falta alguna pieza. El arnés no instala ni configura el sistema.

## 13. Presupuesto

Tres bolsas, cada una con su libro, como el fondo de las ramas:

- **tokens del modelo fuerte** (investigador y maestro);
- **horas de GPU** de entrenamiento;
- **ensayos:** inferencia del junior y llamadas al Judge, con contadores y límites separados. En inferencia local se
  registran también tiempo de GPU, tokens de texto y pasos o tokens del circuito; una respuesta corta puede contener
  mucho cómputo interno. Las sondas y el lado del junior de una destilación también se pagan de esta bolsa; el lado
  del maestro, de la de tokens del modelo fuerte.

Cada palanca cuesta algo distinto. El investigador ve lo que le queda de cada bolsa y elige también por coste. Un ensayo
o un entrenamiento que su bolsa no puede pagar no se lanza.

La reserva cubre la operación completa, incluidas consultas al maestro, comparaciones desde cortes y verificaciones
que consuman inferencia. No se suman tokens y horas como si fueran la misma unidad. Cada operación declara sus topes
y se detiene bajo esos controles; liquida el consumo observado y mantiene reservado el incierto. Las ramas sólo se
habilitan cuando su trabajo cabe en esas reservas: no obtienen un fondo implícito adicional.

## 14. Fase B: el relevo

**Contrato de relevo:** `handover` está ausente por defecto y eso mantiene la fase B desactivada. Para activarla, el
operador fija una referencia al manifiesto de evaluación, paquete candidato, política de aprendizaje, batería
reservada, umbrales por ID de componente, tolerancias de retención y presupuesto de la siguiente generación. No hay
un umbral implícito basado en el número de peldaño. La activación exige superar todas las condiciones con evaluación
completa de confirmación y la aprobación prevista en §12; cualquier resultado inconcluso mantiene la fase A.

**Superado el umbral:**

- **El investigador del mundo pasa a ser el propio junior:** investiga sobre su propia versión, con las mismas
  palancas, puertas, presupuesto y confirmación fuera de su alcance.
- **El modelo fuerte pasa a ser una palanca más:** la destilación desde un corte, que el junior decide cuándo pedir y
  paga de su bolsa.
- **Su memoria persistente queda a su cargo:** decide qué escribe, qué borra y dónde. Un arranque mínimo inmutable en el
  prompt le indica dónde está su política de memoria, que él escribe y reescribe, y el arnés guarda copias para volver
  atrás. Publicar esa memoria para otros ensayos sigue §5.3.
- **La metapolítica de aprendizaje** es el procedimiento con el que elige palanca, caso y momento. Se conserva y se
  investiga con el contrato de §14.1, introducido ya en la fase A.

Los valores de `handover` se configuran a partir de lo observado en desarrollo durante la fase A, antes de consultar
la batería reservada. Se conserva el contrato evaluado y el acto de activación; cambiar un umbral exige otra evaluación.
En una generación, los pesos, la configuración y la metapolítica activa del investigador permanecen congelados mientras
producen y evalúan descendientes; su memoria de trabajo puede cambiar según §5.3 y sus revisiones de política son candidatas.
Una versión promovida puede investigar la generación siguiente; no cambia los pesos del investigador que la está
calificando en mitad de esa evaluación.

### 14.1 El procedimiento de aprendizaje es un artefacto propio

`learning-policy@1` empaqueta un procedimiento legible que orienta al investigador exterior. Reutiliza M1 para decidir
y el canal de consejos para entregarlo; no crea un intérprete que ejecute actos o entrene modelos por su cuenta.

| Parte | Contrato |
| --- | --- |
| `policy` | Un `research-policy@1`: observaciones, reglas opcionales, composición, estado inicial y plantillas |
| `procedures` | Mapa de ID a instrucciones UTF-8 con SHA-256 completo y contenido conservado |
| `template_procedures` | Mapa de plantilla a lista ordenada de IDs de procedimientos que acompañan su consejo; vacío si no necesita ninguno |
| `scope` | Versiones de mundo, capacidades e instrumentos requeridos; condiciones bajo las que puede usarse |
| `provenance` | Padres, autoría, cortes y ensayos que motivaron cambios, hipótesis, fallos y conocimiento transferido |
| `evaluations` | Referencias a evaluaciones completas o parciales, sus condiciones y resultados; nunca una autoevaluación como veredicto |

El cargador verifica dependencias y `scope` antes de iniciar M1. Materializa cada plantilla concatenando su texto y
los procedimientos vinculados en el orden declarado, separados por dos saltos de línea. No hay inclusiones recursivas,
lecturas de archivos durante la decisión ni ejecución de recetas. Los parámetros `{{nombre}}` de los procedimientos
deben estar declarados en los argumentos de esa plantilla; el resultado pasa el validador existente de `research-policy@1`.
Un ID inexistente, hash distinto o argumento sin declarar invalida el paquete; nunca se omite silenciosamente una receta.
La configuración del ensayo fija `context` y `limits` de M1, y el tamaño máximo del consejo; una expansión que exceda
ese tamaño se rechaza, no se recorta. Quedan registrados el paquete original, la política expandida, la configuración
efectiva y el texto entregado. El hash de ejecución incluye esa configuración y el algoritmo de expansión versionado.

La entrada es la vista autorizada de la investigación exterior: errores y progresos del junior ya observados,
intervenciones realizadas, resultados comunicados y recursos visibles. Los recibos de entrenamiento, destilación y
ensayos se exponen como resultados de herramientas de ese mundo; no se abre a la política el registro privado de
confirmación. Se conserva `research-view@1` y se usan observaciones sobre esos resultados, sin acceso lateral a archivos.

La salida sigue siendo un consejo o una abstención. Una plantilla puede proponer una palanca, un caso o un corte y un
procedimiento con parámetros; por ejemplo, destilar una petición que falló antes de invertir en otro entrenamiento.
El investigador decide si lo aplica mediante las herramientas normales. La recomendación, su uso efectivo y su coste
se registran por separado. Una orientación no amplía permisos ni reserva por sí sola trabajo no solicitado.

El hash de ejecución incluye política, procedimientos y condiciones de uso que afectan a su comportamiento. Su
procedencia conserva el historial de edición; el catálogo puede seleccionar el paquete como otra skill del método.
Una receta escrita por el maestro conserva siempre esa autoría; la evidencia de utilidad se registra aparte.

### 14.2 Cómo se aprende y se comprueba el procedimiento

Durante la fase A, el investigador fuerte puede proponer y revisar ese artefacto a partir de su investigación. Puede
usar búsqueda evolutiva sobre su población, con la misma separación entre desarrollo y promoción de §10. El mejor
junior encontrado y la mejor metapolítica encontrada no tienen por qué proceder de la misma rama.

La unidad para evaluar una metapolítica es **una investigación completa de mejora**, con un junior de partida,
casos de desarrollo, herramientas, investigador exterior y bolsas fijados. Los ensayos interiores miden juniors;
no se cuentan como investigaciones independientes del método que los produjo. Se compara el procedimiento candidato
con una referencia fijada antes de evaluar, por ejemplo el mismo investigador sin ese consejo o con una receta fija.

El resultado de cada investigación es el último junior promovido provisionalmente bajo §10, o el junior de partida
si ninguno lo superó. Se registra ese hash al cerrar; no se escoge después otro descendiente mirando la confirmación.
Llegar al presupuesto normal cierra una investigación medible con ese resultado; una cancelación externa o fallo de
infraestructura conserva un resultado parcial y no completa la comparación. La validez de la metapolítica se comprueba
con su contrato M1 y sus dependencias; la suite del circuito corresponde a los juniors que produce, no al texto de la política.

Cada condición parte de copias independientes del mismo junior y experiencia autorizada. El evaluador contrasta los
juniors producidos bajo el contrato de §6.3 y las tolerancias de §10, y conserva el coste total de buscarlos. La memoria
y los resultados de una condición no pasan a otra. Una investigación sin mejora, interrumpida o inconclusa conserva
ese estado; no se atribuye a la política una mejora sólo porque estuvo activa.

La fase A entrega ambos artefactos y sus evidencias, aunque la utilidad del procedimiento resulte inconclusa. Declarar
que se ha aprendido un método útil requiere observarlo producir mejoras en nuevas investigaciones bajo las condiciones
de comparación. La fase B añade que el junior participe como investigador de ese método y lo use en generaciones
posteriores; no exige una segunda arquitectura de orquestación.

## 15. Aceptación de la fase A

La aceptación comprueba los contratos implementados; la mejora del junior y la utilidad del método requieren además
los resultados reales correspondientes. Las pruebas de recuperación y aislamiento pueden usar modelos simulados.

1. Cambiar pesos, memoria inicial, firmware o decodificación cambia la identidad efectiva; otra versión nunca hereda
   medidas de la anterior. Se detecta una versión servida distinta de la pedida y una dependencia ausente del paquete.
2. Una petición repetida devuelve su recibo sin duplicar escrituras. Se comprueban desconexiones antes y después de
   publicar, petición pendiente, estado anterior incorrecto y sesiones concurrentes aisladas.
3. `lab verify` reconstruye conversación y memoria desde un snapshot no vacío sin red ni inferencia. Detecta traza,
   snapshot o recibo alterados. Reanudar en vivo restaura el último estado publicado; no vuelve al estado inicial.
4. Cada ensayo independiente comienza con su memoria congelada. Transferir memoria de desarrollo crea una versión
   con procedencia; una memoria de confirmación no se incorpora al aprendizaje de una condición reservada.
5. Las medidas conservan unidad, denominador y cobertura. La normalización produce el déficit esperado en ambas
   direcciones, no recompensa omisiones de competencias exigidas y no convierte una evaluación incompleta en élite.
6. Una candidata válida que retrocede puede conservarse y desarrollarse, pero no se promueve incumpliendo las
   tolerancias. Las pruebas funcionales deciden la retención; KL por sí sola no acepta ni descarta una mejora.
7. El corte de destilación reconstruye mundo, conversación, herramientas y memoria autorizados, sin acceso al futuro.
   Se comprueban maestro equivocado, corrección de formato, demostración no verificada y comparación inconclusa.
   Las herramientas de memoria del maestro las atiende el simulador de referencia sobre una copia del estado del
   corte; sus escrituras no alteran el corte ni la memoria del junior, y cada llamada consta en el registro.
8. Dataset y entrenamiento conservan entradas, máscaras, procedencia, consumo y productos por hash. Un ejemplo no
   verificado no entra como corrección; una receta con demostraciones las identifica. Un trabajo fallido no se publica
   como entrenamiento terminado ni se vuelve a cobrar como una ejecución nueva al recuperar su recibo.
9. La suite del ordenador ejercita también memoria precargada y restaurada. Una versión que pierde su exactitud se
   rechaza antes de los ensayos de competencia y queda disponible como antecedente de una reparación.
10. El evaluador de confirmación materializa el paquete congelado fuera de la máquina modificable. No entrega al
    investigador sus casos, trazas privadas ni memorias; lo destilado, la ayuda y el formato forzado constan en resultados.
11. Un `learning-policy@1` se carga, aconseja y reproduce mediante M1. Su evaluación identifica la investigación de
    mejora en la que se aplicó y los juniors que produjo. Disponer de ese artefacto no se presenta como utilidad probada.
12. La consigna visible, su posición, el modo de estado, el corte y el comprobador forman parte de la identidad de la
    sonda. Una petición válida con argumentos distintos de los del maestro se acepta; una respuesta que incumple el
    tipo solicitado se rechaza. Una consigna incompatible con el corte y un corte de confirmación se rechazan antes
    de inferir. Una caída del servidor deja la medida incompleta, no puntúa como respuesta vacía del junior.
13. Cada trabajo registra la GPU en la que corrió; la inferencia del junior y el entrenamiento no comparten GPU sin
    declararlo.
14. Se comprueban candidatos que difieren sólo en prompt, memoria inicial o decodificación: el prompt y la decodificación
    efectivos son los del candidato en ambos modos; `start` usa su memoria inicial y `cut` usa el snapshot declarado.
    Ninguna modalidad carga cachés del modelo original, duplica el prompt de arranque ni reejecuta escrituras al precargar
    el contexto. Cambiar la memoria inicial no altera la memoria efectiva de una sonda `cut`, y ese resultado no se
    atribuye a la palanca de memoria inicial.
15. Un ejemplo derivado de un grupo de selección bloquea su entrenamiento bajo esa condición. Pasarlo a entrenamiento
    exige una condición común nueva y recalcular también la referencia. Caso mínimo: padre con aciertos `[1, 0]` y
    descendiente con los mismos aciertos; retirar la segunda sonda nunca permite comparar el `1/1` del descendiente con
    el `1/2` antiguo del padre. Se comprueban la reutilización trazable de evidencia aplicable, la falta de una prueba
    nueva y la contaminación descubierta en un antecesor; ninguna permite una promoción con evidencia incompatible.
16. Las repeticiones de una sonda restauran el estado de prueba y no comparten escrituras. Cada caso conserva su peso
    con una respuesta determinista o cuatro muestreadas; los componentes `start` y `cut` mantienen cobertura y
    denominadores separados, y las cuotas por mundo de §6.3 se cumplen también tras cambiar la condición.
17. Agotar el límite de una sonda produce su fallo medido; desconectar el servicio o agotar el tiempo de cola produce
    un resultado incompleto. Un trabajador invalidado no puede publicar tarde. Repetir `operation_id` devuelve el mismo
    trabajo y consultar su resultado no duplica coste, entrenamiento ni ensayo; cancelar preserva productos y gasto.
18. Se carga una política con un procedimiento parametrizado, se comprueba el texto expandido y se reproduce sin leer
    archivos externos. Se rechazan referencia ausente, hash distinto, argumento no declarado y consejo excesivo.
    Cambiar contexto, límites o expansión cambia la identidad efectiva; la política no amplía el presupuesto del ensayo.
19. El manifiesto se valida antes de inferir: una métrica incompleta, un componente sin casos o un snapshot incompatible
    lo invalidan. Las repeticiones muestreadas usan semillas distintas y registradas, iguales entre candidatos. Valores
    no finitos o medidas ausentes no producen calidad. La promoción se reconstruye sin modelos con su procedimiento
    versionado y evidencia completa; la línea base referencia el manifiesto sin formar un ciclo en su hash.
20. Sin `handover` no se cambia el investigador. Con un componente insuficiente, confirmación incompleta o sin aprobación
    tampoco. Activarlo conserva el contrato, paquete y política que se usarán; no cambia el investigador de un ensayo
    ya abierto. Una investigación de mejora que acaba por presupuesto entrega su último promovido o la base; una
    interrumpida por infraestructura no se convierte en una comparación completa del método.
21. `paired-cases@1` da `promoted`, `not_promoted` e `inconclusive` en casos construidos a mano: una mejora clara, una
    regresión protegida que la compensa otra mejora, y una mejora no significativa. El verificador de referencia es
    el mismo proceso en `lab verify` y en el simulador del maestro. Un paquete sin él no es verificable. Sin el
    montaje de §12 completo, la comprobación previa impide empezar la investigación.

## 16. Entregas

| Etapa | Depende de | Entrega |
| --- | --- | --- |
| **MA1 · Servidor y reproducción** | — | Sesiones, recibos idempotentes, recuperación y verificador; identidades completas, paquetes cerrados y prueba de recursos del driver; verificador de referencia como dependencia del paquete; intermediario de proveedores fuera de la máquina y comprobación del montaje de §12 |
| **MA2 · Escalera y línea base** | MA1 | Manifiesto validado, libro de trabajos, `change`/`run`, adaptador M2 para paquetes, cortes y sondas, partición común, medidas y promoción de §10 |
| **MA3 · Palancas sin entrenar** | MA2 | Prompt, memoria inicial y decodificación como cambios del mundo; `publish_memory` y uso de promoción sin entrenamiento |
| **MA4 · Destilación desde un corte** | MA2 | `distill`, copias del corte, simulador de memoria del maestro, aceptación de ejemplos y datasets con control de solapamiento |
| **MA5 · Entrenamiento** | MA3 y MA4 | `train` recuperable con LoRA, diagnóstico de capacidad, validez del circuito y retención funcional, usando la promoción existente de MA2 |
| **MA6 · Confirmación externa** | MA2 | Materialización aislada, ejecución reservada y publicación autorizada; se aplica también a mejoras sin LoRA |
| **MA7 · Método reutilizable** | MA3 | Cargador de `learning-policy@1`, expansión M1, catálogo y comparación de investigaciones de mejora; incorpora las palancas de MA4/MA5 cuando estén disponibles |
| **Fase B · Relevo** | MA5, MA6 y MA7 | Activación mediante `handover`, investigador congelado por generación y nueva generación desde el paquete aprobado |

MA1 y MA2 ya dan algo útil: saber dónde falla el junior en el arnés, medido con el arnés. Los casos reservados están
fuera de su máquina desde el inicio; MA6 implementa su ejecución y verificación, no aplaza ese aislamiento. MA7 puede
comenzar con las palancas sin entrenamiento de MA3: no necesita esperar a una mejora por LoRA para investigar el método.
Las sondas de MA2 necesitan reconstruir un corte en una copia aislada, sólo para que responda el junior; MA4 parte de
esa reconstrucción y añade el maestro, su simulador de memoria y la aceptación de ejemplos.

MA2 incluye un manifiesto mínimo ejecutable con servidor simulado y pruebas de los actos; MA1 añade la prueba real
del driver y MA5 la de entrenamiento. Las pruebas de contrato no requieren llamadas pagadas al modelo fuerte.
La misma operación y el mismo libro sirven al investigador, a una ejecución directa del operador y a la verificación.
No se mantienen protocolos distintos para pruebas y runs reales.

Los puntos de integración son `lib/src/meta/lab.ts` para ensayos y reservas, `lib/src/artifacts/store.ts` para ediciones,
`lib/src/runtime/replay.ts` para respuestas registradas y `lib/src/learn/assisted/research-policy.ts` para M1. El nuevo
adaptador de competencia se registra como laboratorio; reutiliza esas piezas sin cambiar el significado de las
evaluaciones de políticas de M2 ni el de los mundos de artefactos existentes. Las pruebas de regresión cubren ambos.

## 17. Límites

- **No se promete que un 4B llegue al umbral.** Un resultado negativo bien medido, que diga qué peldaño no alcanza y
  con qué palancas se intentó, también es un resultado.
- **Que las métricas suban no prueba por sí solo que haya aprendido método.** La transferencia a mundos reservados
  aporta evidencia de generalización del junior; aplicar una metapolítica a nuevas investigaciones evalúa la utilidad
  del procedimiento para mejorarlo. Son resultados distintos.
- **Lo destilado de un modelo fuerte limita la afirmación:** un junior mejorado por destilación muestra lo que puede
  aprender de él, no lo que habría descubierto solo.
