# PLAN · Política de exploración y primitivas «¿Y si…?»

Estado (21/10/2026): **plan anterior sustituido en lo relativo a `what_if`**.
Rige [SPEC-DELEGACION-INVESTIGACIONES.md](SPEC-DELEGACION-INVESTIGACIONES.md): eliminar la herramienta y sus
superficies exclusivas, sin compatibilidad ni preservación de runs. Las capacidades independientes, como el cierre
de rondas, permanecen. Las entregas y comparaciones siguientes no justifican mantener un segundo mecanismo.
Desarrolla [SPEC-Y-SI.md](SPEC-Y-SI.md) con la decisión de permitir cierres y cambios de dirección autónomos.

## 1. Resultado que queremos

Una política neurosimbólica observa el recorrido visible de la investigación y decide si conviene continuar,
cerrar una ronda, pedir un giro o pedir alternativas incompatibles con un discriminante. System 2 formula las
ideas y decide cómo investigarlas. Los resultados de los experimentos permiten después revisar la política.

El circuito mínimo es:

**Resultados del run → observaciones → reglas Jev → decisión → dirección de System 2 → experimentos habituales.**

La política es un artefacto separado del modelo del mundo: observaciones, reglas y composición inspeccionables,
con versión y procedencia. La primera versión será una hipótesis metodológica escrita por nosotros; aprenderla
significa que un investigador puede modificarla a partir de experiencia y contrastar la modificación en otros mundos.
No se presupone que esa primera política mejore el rendimiento.

Se habilita explícitamente por run. Sin habilitarla, el comportamiento actual se conserva. Primera cobertura:
mundos del bucle común de leyes; los bucles propios, como cuadrícula, quedan fuera hasta conectarlos expresamente.

## 2. Contrato de decisión

| Salida | Efecto en modo automático |
|---|---|
| `continue` | Seguir explorando la ronda actual |
| `close_round` | Cerrar sin presentar un modelo nuevo; continuar en otra ronda si queda presupuesto |
| `turn` | Cerrar y solicitar a System 2 una nueva dirección para abrir la ronda siguiente |
| `fork` | Cerrar y solicitar dos alternativas incompatibles en una premisa y una forma de distinguirlas |
| `abstain` | Conservar el control habitual del investigador por falta de fundamento suficiente |

Una evaluación no ejecutada por límites o fallida se registra como tal, separada de estas decisiones.
La salida incluye una razón breve y referencias a las observaciones y reglas que la sustentan.
`turn` y `fork` seleccionan la operación; no redactan hipótesis mediante reglas.

Cerrar una ronda no termina el run, reinicia validaciones ni descarta modelos, memoria o contraejemplos. Consume
la ronda correspondiente y conserva todo el gasto. Una dirección no es evidencia ni un nuevo modelo aceptado.
La bifurcación no lanza investigadores paralelos: el investigador diseña el experimento discriminante con las
herramientas disponibles. Puede descubrir que ninguna alternativa sirve o que necesita reformularlas.

## 3. Entrega 1 · Cierre explícito de rondas

**Archivos:** `lib/src/learn/law-session.ts`, `lib/src/learn/law-explorer.ts`,
`lib/src/runtime/lab-runner.ts`, `lib/src/learn/assisted/own-tests.ts`.

- Introducir un resultado de ronda que distinga propuesta, cierre voluntario y salida sin propuesta por otras causas.
  Añadir una entrada tipada para el runner y conservar `consult` como adaptador para sus consumidores actuales.
- Añadir la acción explícita del investigador para cerrar una ronda con motivo. La política usará la misma transición.
- Aplicarla únicamente después de terminar y registrar el lote de herramientas en curso; nunca interrumpir una
  intervención ni omitir las restantes operaciones ya aceptadas del lote.
- Separar el cierre de la evaluación de una propuesta. Ejecutar las pruebas propias pendientes al cerrar, como
  promete su contrato actual; publicar sus resultados aunque no haya propuesta. No llamar a `closeBy` sin un modelo
  nuevo ni borrar contraejemplos. Respetar los límites existentes y registrar cualquier prueba no ejecutada.
- Mantener el último modelo disponible y revisar reanudación, referencias por ronda y coordinación con el senior.

**Motivo concreto:** el runner actual continúa cuando `consult` devuelve `null`, salvo fallo fatal; no existe un
cierre voluntario identificado. Además, `runPending` está después de la comprobación de que hay propuesta.
Añadir simplemente otra salida `null` dejaría ambiguo el cierre y podría posponer pruebas que debían ejecutarse.

**Verificación:** cerrar la primera ronda sin modelo; cerrar después de una propuesta; conservar el último modelo;
ejecutar pruebas registradas una sola vez; mantener contraejemplos y presupuestos; terminar al agotar las rondas.

**Hecho (19/10/2026).** Las pruebas están en `lib/test/close-round.test.ts`.

- **La respuesta del investigador asistido** es `{"close_round": {"why": "..."}}`, sola o con sus notas. Junto a un modelo
  o a una investigación se rechaza, y sin `why` también.
- **`LawSession.roundEnd`** dice cómo acabó cada ronda: `proposal`, `closed`, `no_proposal`, `reflected` o `stopped`.
  `consult` sigue siendo el adaptador de siempre, que devuelve un registro o `null`.
- **El runner, ante un cierre:**
  - ejecuta una vez las pruebas propias pendientes de esa ronda;
  - publica sus resultados con la siguiente ronda, en `last_check.your_tests`;
  - no llama a `closeBy`, así que no cierra contraejemplos de ningún modelo;
  - no comprueba nada: el último modelo queda como estaba.
- **La siguiente ronda** empieza con `you_closed_round` (su ronda y sus palabras). La ronda cerrada cuenta como una más.
- **En el prompt,** `CLOSE_ROUND_SECTION` va en el sistema del asistido desde su primera pregunta.
  - Lo controla la capacidad `close_round` (`capabilities_from`). Un diario anterior reanudado no la tiene; uno continuado
    la tiene desde sus rondas nuevas.
  - `--no-close-round` es la condición sin ella, y va en la configuración del diario, así que también en la identidad
    del generador.
- **El investigador puro** queda como estaba: no lo ve, y un cierre suyo es una propuesta rechazada.
- **El senior ve los cierres** en la vista del registro (`round_closed`), y las trazas de K4 los cuentan (`rounds_closed`).

**Pendiente de la entrega:** la política usará esta misma transición (Entregas 3–4). El mundo de cuadrícula, con su bucle
propio, queda fuera, como dice §1.

## 4. Entrega 2 · Primitiva generativa de System 2

**Archivos:** nuevo `lib/src/learn/assisted/what-if.ts`, despacho y prompt de investigación,
`lib/src/learn/lab.ts` y `lib/src/runtime/lab-runner.ts`.

- Implementar el contrato `what_if` del spec: `turn` devuelve una idea; `fork`, alternativas y discriminante;
  `no_direction` expresa que no se encontró una dirección defendible.
- Usar una llamada aislada de System 2, inicialmente con el mismo cliente y configuración del investigador.
  No hace falta otro agente persistente ni un modelo adicional.
- Admitir uso manual durante una ronda. Para el uso automático, construir una solicitud reproducible a partir
  de la razón de la política, las últimas notas del investigador y la ventana visible declarada. System 2 recibe
  ese material directamente; no introducir otra llamada obligatoria para resumirlo.
- Tras un cierre automático, resolver las pruebas pendientes antes de preparar ese contexto: sus resultados
  pueden cambiar la dirección que merece explorarse. Entregar la sugerencia al comienzo de la siguiente ronda.
- No generar si ya no puede abrirse esa ronda. La generación consume un paso de la ronda receptora y presupuesto
  de inferencia. Una respuesta inválida o vacía no inicia una cadena de reintentos ni impide continuar normalmente.

**Verificación:** ambos modos con cliente simulado; formato inválido; referencias prohibidas; contexto demasiado
grande; cierre sin presupuesto restante; incorporación de resultados de pruebas al contexto; gasto contabilizado.

**Hecho (19/10/2026), en su parte manual.** El código está en `lib/src/learn/assisted/what-if.ts` y las pruebas en
`lib/test/what-if.test.ts`.

- **La petición:** `{"what_if": {"mode": "turn" | "fork", "situation", "question", "refs"}}` dentro de `investigate`.
  - El modo `turn` responde `idea`; `fork` responde `a`, `b` y `difference`; si no hay dirección, `no_direction`.
  - Una respuesta con otra forma se registra y no se reintenta.
- **La llamada es aislada:** el mismo cliente de System 2, sin nada de la conversación. Recibe sólo `situation`,
  `question` y los elementos de memoria que se citaron, abiertos enteros.
  - Una referencia que no existe se rechaza antes de llamar.
  - Más de 24.000 caracteres también se rechaza: nunca se recorta.
  - Sin memoria selectiva, las referencias se abren con una memoria construida sobre la sesión.
- **El registro:** `what_if_requested` se escribe **antes** de la llamada, y `what_if` con la respuesta o el error,
  después. Los ids son `what_if:<quién>:r<ronda>.<n>`.
  - El replay la sirve como cualquier llamada del canal `llm`, y `lab verify` la reconstruye sin red.
  - Sus tokens son los del run.
- **El coste:** un paso de investigación y una llamada de su límite (`--what-if-max`, 6 por defecto).
  `what_if_left` aparece en el presupuesto visible y en cada respuesta.
- **Disponible siempre para los dos hemisferios.** `--no-what-if` la quita a los dos, y va en la configuración (con
  `what_if_max` y la versión de la instrucción). Las secciones van en el sistema desde la primera pregunta, bajo la
  capacidad `what_if`.
- **El senior** la tiene entre sus lecturas, con referencias a la memoria del junior y a la suya.
  - Consume una lectura y una llamada; sus tokens se suman a su registro de agente.
  - La respuesta queda en su decisión (`what_if`). Lo que llega al junior es lo que el senior haga con ella, en su propio
    mensaje.
  - Su sección va antes de su rol.
- **Cada hemisferio sabe qué pidió el otro:**
  - el senior ve en la vista del registro las peticiones y respuestas del junior;
  - el junior recibe en su canal un aviso con el id, el modo y la `situation` de cada petición del senior (llega por la
    bandeja como `what_if_requested`);
  - ese aviso queda como hecho del registro y nunca cuenta como ayuda.
- **Las trazas de K4** cuentan las peticiones de cada hemisferio.

**Pendiente:** el uso automático, que construye la petición a partir de la decisión de la política, va con las Entregas
3–4.

**Revisión de las Entregas 1–2 (19/10/2026): una externa y nuestra propia introspección.** Pruebas en
`lib/test/entregas-review.test.ts`.

- **El senior cuenta los cierres como rondas completadas:** activan su revisión y avanzan su contador. Además,
  `stuckSignals` da una señal nueva, «cerró sus últimas N rondas sin un modelo nuevo», a partir de dos seguidas.
- **Las referencias funcionan sin memoria selectiva.** La sesión guarda un registro por ids (investigaciones y
  comprobaciones incluidas) que el investigador nunca ve. Sirve para abrir lo que cita, de modo que `investigation:r1.1`
  existe también sin `--memory selective`.
- **Las peticiones del senior tienen ids únicos:** `what_if:<agente>:r<ronda>.<n>`, con la cuenta en su estado y no en
  cada llamada.
- **El registro del senior es durable.** Cada petición, entera, se guarda en su registro de agente **antes** de la
  llamada, con su consumo, y la respuesta después; el archivo se escribe en el momento.
- **Un cierre con directivas abiertas del senior se devuelve una vez,** como una propuesta. Así cerrar no sirve para
  no rendir cuentas.
- **Sin llamada pasado el presupuesto:** el `what_if` del junior consulta `halt` antes de llamar, y responde «not
  asked: token_budget».
- **Sólo donde hay pasos:** sin herramientas de investigación, `what_if` no se ofrece.
- **Las trazas de K4** dan a `what_if` su propia clase de paso (`asking_a_direction`).
- **Un run con cierres** se reconstruye sin red (`lab verify`).

**Límites conocidos:**
- **Las llamadas del senior no se reproducen** al reanudar, igual que el resto de su agente, que no tiene registro de
  repetición. El replay vale para el junior; del senior queda el registro durable.
- **El límite `--what-if-max` es por hemisferio** (6 cada uno), no compartido. Encaja con «los dos la pueden usar
  siempre».
- **Una petición rechazada consume su paso,** como cualquier herramienta que responde con un error.

## 5. Entrega 3 · Política neurosimbólica sobre el recorrido

**Archivos:** nuevo `lib/src/learn/assisted/exploration-policy.ts`, integración en `law-session.ts` y runner;
reutilización de `lib/src/core/formula.ts`, `observer.ts`, `jev.ts` y `output.ts` según sus contratos.

- Definir una proyección de entrada estable: acciones y resultados visibles, preguntas y notas registradas,
  últimas comprobaciones comunicadas, pruebas pendientes, presupuesto y decisiones previas. Nunca usar el diario
  bruto: contiene información exclusiva del operador. Congelar e identificar cada ventana evaluada.
- Obtener contadores mediante código y juicios semánticos mediante Jev. Ejemplos iniciales: repetición del mismo
  enfoque, incertidumbre que no se aclara, prueba discriminante pendiente y alternativas aún sin contrastar.
  No inventar una medida universal de incertidumbre ni tratar los valores de Jev como probabilidades calibradas.
- Componer una salida del contrato anterior mediante `output`, con umbrales y precedencia explícitos. Reutilizar
  las piezas del núcleo; evitar fabricar un mundo de juego para adaptar el evaluador completo a este problema.
- Evaluar tras un lote con evidencia nueva y antes de la siguiente consulta del investigador. La política declara
  ventana, frecuencia y separación entre disparos. Leer memoria o emitir un aviso no dispara otra evaluación.
- Validar entradas desconocidas antes de componer: un juicio ausente no equivale a cero. Usar el sandbox existente
  y mantener fuera del artefacto los controles de acceso, gasto y cancelación.

**Verificación:** decisiones deterministas con juicios simulados; precedencia; abstención; fallo de Jev; ausencia
de filtración de información oculta; no recurrencia por avisos; caché ligada a entrada, regla y configuración del juez.

## 6. Entrega 4 · Integración autónoma, registro y reanudación

**Archivos:** configuración del run, runner, `lib/src/runtime/replay.ts`, memoria y lectores de experiencia.

- Exponer modos `off`, `recommend` y `auto`, versión de política y límites. `auto` es parte de esta entrega;
  `recommend` sirve para observar y comparar la misma política sin concederle control sobre las rondas.
- Conservar por evaluación: entrada, versión, juicios, decisión, transición aplicada o motivo de no aplicación;
  y por generación: solicitud exacta, respuesta, error y consumo. Incluir Jev y System 2 en el coste total.
- Persistir el cierre y la intención de generar con identidad estable. Al reanudar, completar únicamente lo pendiente;
  replay reproduce las decisiones y respuestas grabadas sin nueva inferencia.
- Una caída antes de persistir la respuesta externa puede dejar una llamada de resultado desconocido: registrarla
  como incierta, sin afirmar garantía de exactamente una llamada ni volver a gastarla silenciosamente.
- Hacer recuperables las direcciones y versiones de política desde la memoria y experiencia existentes. No crear
  otro almacén de investigación ni un grafo obligatorio.

El soporte de registro y presupuesto se desarrolla junto a las entregas anteriores; esta entrega verifica el circuito
completo. No se habilitan llamadas reales antes de contar con ese soporte.

**Verificación:** replay sin red; reanudar antes/después del cierre y de la generación; límites agotados;
cancelación; política desactivada conserva el flujo anterior; senior y registro de rondas observan el mismo cierre.

## 7. Entrega 5 · Aprender y contrastar la política

- Dar al investigador acceso a runs de desarrollo mediante `experience` y a la política usada como artefacto
  versionado. Puede proponer cambios de observaciones, reglas o composición con padre, motivo y contenido íntegro.
- Validar el artefacto antes de usarlo; una política propuesta no se activa solo por haber sido escrita. El batch
  declara qué versión ejecuta y la congela durante cada run. La autoedición durante el run queda para otra variante.
- Empezar con dos mundos soportados y semillas de desarrollo, reservar otras tareas para evaluación y reservar
  otra familia antes de afirmar transferencia entre dominios.
- Comparar primero uso manual frente a automático con la política inicial. Después comparar política inicial
  frente a aprendida, manteniendo proponente, contexto disponible y presupuesto total comparables.
- Usar el resultado habitual del mundo como criterio principal. Examinar también experimentos discriminantes,
  vías abandonadas y retrocesos con sus evidencias; no recompensar cantidad de giros ni una puntuación de creatividad.
  Si aparece mejora, contrastarla con un disparador sencillo y con deliberación adicional de coste equivalente.

**Cierre de la feature:** un run puede cerrar una ronda, recibir una dirección, investigarla y reproducir toda esa
secuencia; otro investigador puede inspeccionar la experiencia, proponer una política distinta y probarla sin cambiar
los criterios de aceptación del mundo. La mejora científica es una hipótesis por evaluar, no un requisito que el código
pueda garantizar.

## 8. Orden y límite de alcance

**Conciliado (19/10/2026, [SPEC-Y-SI §8](SPEC-Y-SI.md)):**
- Implementar 1 → 2, con el registro y los costes de la Entrega 4 adelantados a la 2.
- Pilotar con un lote K3 (sin `what_if` / con `what_if` / control «revisa tu enfoque»). `what_if` está siempre disponible para los dos hemisferios; la condición sin ella es `--no-what-if`, que la quita a ambos.
- El piloto es un diagnóstico, no una condición: distingue «no se usó», «se usó a destiempo» y «a tiempo pero sin
  aporte». Las entregas 3 → 4 → 5 siguen en cualquier caso, porque un resultado manual negativo puede deberse a cuándo se
  pide, que es lo que la política aprende. Sólo «sin aporte» lleva antes a revisar el proponente.

Cada entrega, además:
- declara su capacidad en `CAPABILITIES` (`capabilities_from`);
- entrega sus textos como mensajes nuevos del canal, sin tocar el sistema fijo;
- muestra su límite en el presupuesto visible;
- deja su configuración en la del diario, para que `generatorOf` separe las condiciones.

La política parte de `stuckSignals` (`orchestra/reader.ts`) y añade sus propios contadores: última solicitud de
`what_if`, separación entre disparos, avisos ignorados y presupuesto para desarrollar.

Su entrada es la vista de `orchestra/view.ts` **ampliada** con los resultados visibles de cada paso, las pruebas propias
(registradas, resultados y pendientes) y los `what_if`, sin nada del operador.

Evaluar consume inferencia; entregar una intervención consume una unidad de `help_left`. Un cierre y su dirección
comparten la identidad `intervention:<n>`, para que no se cuenten dos veces.

Orden original: implementar 1 → 2 → 3 → 4 → 5, con registro y costes desde la primera llamada externa. Cada entrega debe dejar un
recorrido verificable antes de añadir la siguiente. Los tests usan clientes simulados; el piloto con modelos reales
es un batch separado y presupuestado, posterior a la comprobación de reanudación y replay.

No incluye NCP, difusión, entrenamiento de pesos, generación de código neurosimbólico para las hipótesis,
investigadores adicionales ni un optimizador nuevo. El objeto aprendido es la **política de exploración**;
la creatividad de las direcciones queda en System 2.
