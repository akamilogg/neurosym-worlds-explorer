# SPEC · Validez de la medida: lo que juzga a un candidato no puede dejarse engañar

Estado (10/11/2026): **VM1, VM2 y VM3 implementadas** (el evaluador de ensayos, la promoción, el vocabulario y la
auditoría, §11); VM4 a VM6 propuestas, sin implementar. Sale de la lectura a fondo del código del
[repaso del repositorio](REPASO-2026-11-10.md) (§4.3, hallazgos V1 a V19). Corrige el evaluador del
[metalaboratorio](SPEC-METAPOLITICA-INVESTIGACION.md), la promoción y la confirmación del junior
([SPEC-METAPOLITICA-APRENDIZAJE](SPEC-METAPOLITICA-APRENDIZAJE.md) §6.5, §9, y [SPEC-EDICION-PESOS](SPEC-EDICION-PESOS.md)
§7), la [auditoría del método](SPEC-AUDITORIA-METODO.md), la comparación pareada de
[SPEC-CONTROL-ARNES](SPEC-CONTROL-ARNES.md) §6.2.1 y lo que un check hace cuando falla el juez
([SPEC-CALIBRACION-INSTRUMENTOS](SPEC-CALIBRACION-INSTRUMENTOS.md)). **Va antes de cualquier ejecución real cuyo resultado
seleccione o promueva algo.**

## 1. De dónde sale

El arnés tiene dos lazos en los que un proceso automático propone candidatos y una medida decide cuál sigue: la búsqueda
de políticas de investigación y la mejora del junior (ediciones, búsqueda de pesos, destilación, entrenamiento). En un
lazo así la medida es el único freno: lo que deja pasar, la búsqueda lo encuentra, sin intención de nadie.

Leyendo el código, la medida deja pasar esto (comprobado con un guion sobre el código del 10/11/2026):

- **Un candidato con un ensayo resuelto y nueve caídos por infraestructura obtiene la calidad perfecta.** Los ensayos
  `infra` salen del denominador y la evaluación cuenta como completa. Un timeout del LLM es `infra`, y lo largo que es
  lo que una política hace escribir al junior depende de la política.
- **Un junior que mejora en formato y pasa de perfecto a lo peor resolviendo mundos queda `promoted`.** Sólo bloquean
  los componentes que el manifiesto marca como protegidos.
- **Con tres casos, ningún componente puede mejorar:** el p mínimo del test es 0,125. El manifiesto se acepta igual.
- **La auditoría clasifica una prueba propia y un `wait` del mundo vivo como «recall»** y no los juzga; y una ronda
  cerrada sin modelo no cierra tramo.
- **Ocho de ocho frente a cero de ocho da «insufficient evidence».**

Y esto, leído sin ejecutar: la destilación sólo se separa de las sondas y no de los casos de investigación; la
confirmación no sabe de dónde salieron los datos de un candidato; un check con el juez caído cuenta como un check.

Nada de esto ha contaminado un resultado, porque ninguno de los dos lazos ha corrido con modelos reales. Es el momento
barato de arreglarlo.

## 2. Principios

- **Y1. Lo que falta no favorece a nadie.** Un ensayo que no midió no cuenta como éxito, ni como fracaso, ni desaparece:
  deja la evaluación incompleta. Es la regla que ya sigue la medida del junior (`measure`); se extiende a todo
  evaluador.
- **Y2. Si el candidato puede causarlo, no es infraestructura.** Un fallo que depende de lo que el candidato hace
  (una respuesta que no llega a tiempo, una que agota su límite) es un resultado suyo y cuenta contra él. Sólo es
  infraestructura lo que habría fallado igual con cualquier candidato.
- **Y3. Promover exige no empeorar en nada medido.** Un componente no protegido deja de ser un componente que puede
  caer libremente: protegido significa una tolerancia más estricta, no la única con consecuencias.
- **Y4. Una medida que no puede decidir se rechaza antes de gastar.** Un manifiesto cuyos casos no dan potencia para
  ningún veredicto se dice al prepararlo.
- **Y5. Un principio, una regla.** La separación entre lo que construye, lo que selecciona y lo que confirma
  (SPEC-EDICION-PESOS E3) se comprueba con la misma función en la destilación, el laboratorio de pesos, el
  metalaboratorio y la confirmación.
- **Y6. Un vocabulario.** Qué es un experimento, una observación y una lectura de memoria se declara una vez, y lo usan
  la auditoría, las señales de atasco y la memoria selectiva.
- **Y7. El instrumento que falla lo dice y no cuenta** (SPEC-CALIBRACION-INSTRUMENTOS): un check sin juez no es un
  veredicto.

## 3. El evaluador de ensayos

### 3.1 Qué es infraestructura

`trialResult` distingue tres causas donde hoy hay una:

| Causa | Ejemplos | Qué es |
|---|---|---|
| **Del candidato** | El junior no contesta dentro de su tiempo; agota `--max-tokens` o las llamadas al juez; una ronda sin propuesta tras sus negativas | Un ensayo **terminado y no resuelto** |
| **Del proveedor, ajena al candidato** | 401/402/403, 429, 5xx, la red, el juez caído | `infra` |
| **Indeterminada** | Un timeout cuya causa no se puede atribuir | `infra`, y se cuenta aparte |

Para atribuir un timeout, el runner registra con cada `proposal_failed` el tamaño de la petición, el tiempo esperado y
el estado HTTP. Un timeout con el servicio respondiendo a otras peticiones del mismo ensayo es del candidato.

### 3.2 Qué hace falta para medir

- Una evaluación es **completa sólo si todos sus ensayos terminaron** (resueltos o no). Con uno solo en `infra`,
  `cancelled` o `unfunded` es incompleta: sin calidad, sin competir.
- Un ensayo `infra` **se reintenta** hasta un máximo declarado en el manifiesto (`infra_retries`, 2 por defecto), cada
  intento con su reserva. Agotados, la evaluación queda incompleta y se dice cuál.
- Un ensayo cuyo run **terminó** con fallos del proveedor no se reanuda (no hay nada que reanudar): se lanza otro
  intento con otro nombre de registro, y el anterior se conserva.
- La tasa de `infra` por candidato se guarda con la evaluación. Una búsqueda cuyas tasas difieren entre candidatos más
  que una tolerancia declarada lo dice en su hallazgo: es la señal de que Y2 se clasificó mal.

### 3.3 Identidad

El id de un ensayo, el nombre del fichero de una política y el hash del manifiesto pasan a SHA-256 (los primeros 24
hexadecimales bastan en nombres). Los registros hechos con el id anterior se siguen leyendo: el libro guarda los dos
mientras existan. Un fichero de política que ya existe se compara con lo que se iba a escribir; si difiere, es un
error, nunca un fichero servido.

### 3.4 Particiones

`manifestProblems` rechaza dos casos con el mismo laboratorio y los mismos argumentos de mundo en particiones
distintas. `partition` del corpus une en un linaje los runs que leyeron la experiencia de otro y los miembros de un
equipo con tablón, además de continuaciones y ramas.

## 4. La promoción del junior

### 4.1 `paired-cases@2`

Cambia tres cosas respecto de `@1`, que se conserva para leer lo ya medido:

1. **Todo componente tiene tolerancia de regresión.** Un componente no protegido que empeora más allá de su tolerancia
   da `not_promoted`. `protected` pasa a significar tolerancia cero salvo la que declare.
2. **La regresión se juzga también con el test,** en el otro sentido: se rechaza si la caída supera la tolerancia **o**
   si es significativa al nivel del manifiesto. Hoy sólo cuenta la media.
3. **El veredicto lleva su potencia:** con cada componente, el p mínimo alcanzable con sus casos.

### 4.2 El manifiesto dice si puede decidir

`competenceProblems` añade, por componente y partición, el p mínimo alcanzable (2⁻ⁿ con n casos) frente a
`alpha` dividido por el número de componentes:

- **Ningún componente puede mejorar:** el manifiesto se rechaza.
- **Alguno no puede:** se acepta y se avisa, con el número de casos que le faltan.

El servicio de confirmación aplica lo mismo a su manifiesto al arrancar.

### 4.3 La selección entre candidatos

- Una búsqueda declara cuántos candidatos midió con las sondas. El candidato que propone para promover se compara con
  la referencia **en casos de desarrollo que la búsqueda no usó para seleccionar** (una parte apartada de las sondas,
  declarada en el manifiesto como `holdout`), o bien con el nivel corregido por el número de candidatos medidos.
- «Promovido por regla» en la comparación A–F (SPEC-EDICION-PESOS §8) usa esa parte apartada. Sin ella, el informe lo
  llama «el mejor de N en selección», nunca promovido.

## 5. La separación de los datos

### 5.1 Una función

`junior/groups.ts` exporta `usesOf(manifest)`: para cada grupo, sus usos (diagnóstico, selección por sonda, selección por
investigación, confirmación). La usan:

- `selectionOverlap` de la destilación, que hoy sólo mira las sondas: pasa a rechazar un dataset que comparta grupo con
  **cualquier** caso de selección o confirmación;
- el laboratorio de pesos (`weightLabProblems`), que ya lo hace por su cuenta;
- los constructores que leen activaciones grabadas.

### 5.2 El linaje viaja con el paquete

Un paquete exportado lleva `provenance.realizations`: de cada dataset, edición construida y consulta del laboratorio que
contribuyó a él, el laboratorio y los argumentos de mundo de los runs de donde salió, por hash. Lo escribe el mundo, no
el investigador. El servicio de confirmación:

- rechaza un candidato cuyas realizaciones coincidan con las de sus casos reservados;
- rechaza un paquete entrenado, destilado o editado que no las declare.

Los casos reservados no salen del servicio: la comparación se hace allí, y el rechazo dice que hay solape, no con cuál.

## 6. La auditoría y el vocabulario

### 6.1 Una tabla de clases de petición

`learn/requests.ts` declara cada petición que un investigador puede hacer con su clase:

| Clase | Qué es | Ejemplos |
|---|---|---|
| `experiment` | Pide al mundo algo que antes no existía | `act`, `replay`, `simulate`, `try`, `launch`, `play`, `wait`, `perturb`, `test`, `edit`, `evolve` |
| `observation` | Lee o calcula sobre lo ya registrado del mundo | `view`, `inspect`, `table`, `measure`, `observe`, un instrumento propio, `inspect_weights` |
| `recall` | Lee su propio registro o sus fuentes | `memory`, las fuentes, `read` |
| `exchange` | Habla con otros | `send`, `share`, `delegate` |

- Cada laboratorio añade las suyas al declararse; una petición sin clase es un error al cargar el laboratorio, no un
  «recall» por defecto.
- La auditoría, `stuckSignals`, `followUpDue` y la memoria selectiva leen de esta tabla. La clase de `table` y
  `measure` (hoy experimento para el senior y observación para la auditoría) se fija en observación; las señales de
  atasco conservan su comportamiento actual tras una opción hasta que una ejecución diga cuál conviene.
- La clave de una petición se obtiene de una sola forma (hoy hay dos: la primera clave, y la primera que no es
  auxiliar).

### 6.2 Tramos

`round_closed` cierra tramo, con su `why` como texto que puede citar pasos. `consolidated` se registra en el tramo como
hecho. Un cierre sólo cita pasos anteriores a él: hoy una reflexión cuenta como posterior a un paso de su misma ronda
que vino después.

### 6.3 Lo que falta se dice

`complete_chains` y cada reparto llevan su denominador y cuántos enlaces quedaron sin juzgar por error. Las auditorías
hechas antes llevan `method_audit@1`; las nuevas, `@2`, y una calibración no mezcla las dos.

## 7. El check y el juez

- **Un check en el que el juez falló en algún punto es nulo:** no cuenta como ronda, no cambia de papel ningún lugar,
  no entra en la regresión pareada, y al investigador se le dice que el instrumento falló, como hecho, sin veredicto.
  Se reintenta una vez con los mismos casos; si vuelve a fallar, la ronda se devuelve.
- **Una respuesta ausente del juez no compone como 0,5 en un check:** el punto queda sin medir. El valor por defecto se
  conserva sólo para la búsqueda que juega con una fórmula, donde un valor neutro es una decisión del juego.
- **Un error transitorio del LLM no es una negativa del investigador:** se reintenta aparte, con su propio máximo, y no
  consume las tres negativas de la ronda.
- `runResults` da «sin dato» donde falta el hallazgo, no `false`.

## 8. La comparación pareada

Con resultados binarios y todas las diferencias iguales y distintas de cero, `pairedComparison` deja de responder
«insufficient evidence» y usa el test de signos exacto sobre los pares discordantes, con su p y el mismo margen
declarado. Con menos de 3 pares sigue sin concluir. La regla escrita en el informe se actualiza.

## 9. Lo operativo

- **Sesión viva reconstruida:** los timeouts de ventana registrados (`w<n>.timeout`) se imponen al reconstruir: el
  miembro que constó como ausente se sella vacío en esa ventana aunque su respuesta reproducida llegue antes. Primero
  la prueba que muestra la divergencia; después el arreglo.
- **Agentes y diario:** leen del registro de líneas de SPEC-CONSOLIDACION CC1. Mientras no exista, una lectura que no
  parsea se reintenta y no se toma por «sin diario».
- **Un agente que falla consta:** el fallo de un senior en una sesión viva se escribe en el registro de la sesión.
- **Nombres de `plates@1` fuera de la capa genérica:** lo que el mundo llama su vista lo nombra el adaptador.
- **El cliente de mundos externos de `living`** se cablea a un laboratorio o se mueve a `historico/` con su prueba.

## 10. Límites

- **Y2 no siempre se puede decidir.** Un timeout puede ser de las dos cosas. Lo indeterminado se queda en `infra` y se
  vigila por su tasa; no desaparece.
- **Más exigencia, menos promociones.** Con `paired-cases@2` y el aviso de potencia, muchos manifiestos pequeños
  quedarán como incapaces de decidir. Es información, y cuesta casos.
- **La parte apartada de las sondas reduce las que orientan la búsqueda.**
- **El linaje del paquete lo declara el mundo que lo construyó.** Protege de descuidos, no de un mundo alterado; para
  eso está que la confirmación corra en otra máquina.
- **Cambiar la clase de una petición cambia cuándo se llama al senior,** y por tanto las condiciones ya medidas con él:
  por eso va tras una opción.

## 11. Entregas

| Etapa | Depende de | Entrega |
|---|---|---|
| **VM1 · El evaluador de ensayos** | — | Las tres causas de §3.1 y lo que el runner registra para atribuirlas; evaluación completa sólo con todo terminado; reintentos; tasa de `infra`; identidades SHA-256; particiones (§3.4) |
| **VM2 · La promoción** | — | `paired-cases@2`; el aviso de potencia en el manifiesto y en la confirmación; la parte apartada y «el mejor de N» |
| **VM3 · El vocabulario y la auditoría** | — | `learn/requests.ts` y sus cuatro lectores; tramos con `round_closed`; denominadores; `method_audit@2` |
| **VM4 · La separación de los datos** | VM2 | `usesOf` y sus tres usuarios; `provenance.realizations` y su comprobación en la confirmación |
| **VM5 · El check y el juez** | — | Check nulo, punto sin medir, reintento del LLM aparte, «sin dato» en `runResults` |
| **VM6 · Comparación y operación** | — | El test de signos en la comparación pareada; §9 |

**Orden.** VM1 antes del piloto de la metapolítica. VM2 y VM4 antes de la línea base de la fase A. VM3 antes de
etiquetar la muestra de la auditoría, porque cambia lo que se juzga. VM5 antes de repetir los hallazgos del README.
VM6 cuando toque.

**VM1, hecha (10/11/2026):**

- **Dónde está.** `lib/src/meta/lab.ts`: `measureOf` da una evaluación completa sólo si todos sus ensayos acabaron
  `ended`; `trialResult` dice la causa de un `infra` (`cause`: `provider`, `harness` o `indeterminate`); los reintentos
  (`infra_retries` en el manifiesto, 2 por defecto) lanzan un intento nuevo `<id>.a<k>.json` con su reserva y su evento
  `research_trial_retried`, conservando el que cayó; ids, hash del manifiesto y ficheros de política por SHA-256 (24
  hexadecimales en nombres); `manifestProblems` rechaza el mismo mundo y realización en dos particiones; la evaluación
  lleva `infra`, `infra_indeterminate` e `infra_rate`; `verifyTrials` lee un libro con la última línea cortada.
  `lib/src/meta/corpus.ts`: un run que leyó la experiencia de otro (por el SHA-256 del fichero leído) y los miembros de
  un equipo son un linaje.
- **Lo que registra el runner.** `requestFailure` (`lib/src/learn/system2.ts`) da a cada `proposal_failed` su `kind`,
  `status`, `waited_ms` y `request_chars`, en `law-session.ts` y en el mundo `grid`. `console_usage.llm_answers` del
  evento `end` cuenta las respuestas de System 2 del run: un timeout con respuestas en el run es del candidato; sin
  ninguna, indeterminado.
- **El junior de un intento nuevo empieza sin estado.** `juniorCandidate` (`lib/src/junior/trials.ts`) continuaba la
  sesión del lanzamiento anterior siempre que existiera; ahora sólo cuando se reanuda un registro. Sin eso, un reintento
  heredaba la memoria del junior del intento que cayó.
- **Una causa más que en §3.1.** `harness`: el hijo cayó, divergió o corrió con otra configuración. Es `infra` y no es
  del proveedor; se reintenta igual.
- **Lo anterior se sigue leyendo.** Las evaluaciones con identidad `meta:` se verifican con la regla de entonces
  (`legacyMeasureOf`); las nuevas llevan `meta@2:`. Un libro empezado con ids FNV continúa sus ensayos con esos ids; un
  `proposal_failed` sin campos se clasifica por las palabras de su error.
- **Pruebas.** Las siete `VM1:` de `lib/test/meta-lab.test.ts`, la de compatibilidad con libros antiguos y la de la
  sesión del junior en `lib/test/junior-trials.test.ts`. Cubren las
  aceptaciones 1 a 4. El bloque `M1` de `lib/scripts/validity-repro.ts` da ahora `quality: null`.
- **Sin comprobar.** El piloto a medias de `runs/meta/meta-pilot` no se ha reanudado con este código: la prueba de
  compatibilidad lo simula, no lo lee. La aceptación 2 se probó con registros escritos a mano y con un runner que falla
  por HTTP, no con un junior real que agote su tiempo. Falta el aviso de §3.2 cuando las tasas de `infra` difieren entre
  candidatos de una búsqueda más que una tolerancia declarada: hoy la tasa va con cada evaluación, pero nadie la compara.

**VM2, hecha (10/11/2026):**

- **Dónde está.** `lib/src/junior/competence.ts`: `promotion.procedure` admite `paired-cases@2`; en él todo componente
  bloquea si su media cae más que su tolerancia o si la caída es significativa con el mismo test al nivel del manifiesto,
  y cada componente del veredicto lleva `n` y `min_p`. `@1` no cambia: ni sus veredictos ni su salida. `powerOf` dice por
  componente y partición si puede llegar a promoverse (2⁻ⁿ frente a `alpha / K`) y cuántos casos necesita;
  `competenceWarnings` lo avisa.
- **Rechazo sólo en `@2`.** Un manifiesto `@2` en el que ningún componente puede promoverse en desarrollo se rechaza
  diciendo cuántos casos necesita cada uno. Con `@1` la misma falta sólo se avisa: rechazarla habría cambiado qué
  manifiestos `@1` son válidos, y los actuales (también los de las pruebas) tienen dos o tres casos por componente. La
  confirmación (`lib/src/junior/confirm.ts`) aplica lo mismo a sus casos reservados al construirse.
- **`protected` en `@2`.** No añade nada: la tolerancia es obligatoria en todo componente desde `@1`, así que no hay
  «tolerancia cero salvo la que declare» que aplicar. Se conserva como atributo.
- **La parte apartada.** `holdout` en el manifiesto: casos de sonda que una búsqueda no usa para seleccionar, validados
  (sondas de desarrollo, cada componente conserva casos para seleccionar, cuotas iguales por mundo en cada parte).
  `selectionManifest` es lo que mide la búsqueda (`probesOf`, `searchEvaluator` en `lib/src/worlds/junior/lab.ts`; sin
  `holdout` da el mismo manifiesto y el mismo hash que antes); `holdoutManifest` y `promoteOnHoldout`
  (`lib/src/junior/evaluate.ts`) promueven un candidato de una búsqueda sólo con esos casos.
- **La comparación A–F.** E (`lib/src/junior/comparison.ts`) promueve sus candidatos sobre el `holdout`; sin él, su
  producto se registra como `best of N in selection` y ningún candidato se anota como `promoted`. El informe lleva
  `rules` (cómo se eligió el producto de cada repetición de C y E) y lo dice en su texto.
- **Pruebas.** Las seis `VM2:` de `lib/test/junior-competence.test.ts` (aceptaciones 5 y 6, la confirmación, el
  `holdout` y la promoción sobre él) y las aserciones nuevas de E y del informe en
  `lib/test/junior-weight-comparison.test.ts`. El guion de reproducción añade `J1 @2` (`not_promoted`) y `J2 warned`.
- **Sin comprobar.** Que los candidatos que el investigador adopta de una búsqueda (condición D) se promuevan sobre el
  `holdout`: el investigador ve todas las sondas y adopta por su cuenta; esto sólo cubre la regla del operador (E). La
  corrección por número de candidatos medidos (la alternativa de §4.3 al `holdout`) no está hecha.

**VM3, hecha (10/11/2026):**

- **La tabla.** `lib/src/learn/requests.ts`: las clases (`experiment`, `observation`, `recall`, `exchange`), las
  peticiones comunes, `requestKey` (la única forma de sacar la clave: la primera que no la califica) y `classOf`, que
  clasifica un acto por su tipo cuando el laboratorio lo declara. `Lab.requests` (`lib/src/learn/lab.ts`) lleva las de
  cada laboratorio: los actos del junior (`edit`, `evolve`… experimentos; `inspect_weights` observación; `confirmations`
  recuerdo). `LivingBridge.REQUESTS` (`lib/src/living/bridge.ts`) las del mundo vivo, y `accepts` lee de ella.
  `requestTableOf` y `requestTableFor` (`lib/src/worlds/labs.ts`) las juntan. Un laboratorio que declara una petición sin
  clase impide cargar el registro (`labRequestProblems`).
- **Diferencias con la tabla de §6.1.** La prueba propia se pide como `register_test`, no `test`. `progress` del mundo
  vivo (el investigador informa de su progreso) es `exchange`. `peers` y `publish` del tablón de un equipo, `exchange`.
- **La auditoría.** `linksOf(journal, { classes })` (`lib/src/audit/links.ts`) clasifica con la tabla; `round_closed`
  cierra tramo (`r<n>.closed`, sus palabras pueden citar pasos); `consolidated` se anota en el tramo; un cierre sólo cita
  pasos anteriores a él en el orden de los eventos. Una petición que ninguna tabla conoce queda `unclassed`, nunca
  `recall`. `{ version: 1 }` lee como antes, para las auditorías hechas.
- **`method_audit@2`.** `lib/src/audit/audit.ts`: las cuentas incluyen `exchange` y `unclassed`; los repartos juzgados
  llevan `of` (de cuántos son) y `unjudged` (cuántos se pidieron y quedaron sin juzgar). `calibrationFormats`
  (`lib/src/audit/calibration.ts`) impide mezclar `@1` y `@2` en una muestra o un acuerdo, y cada auditoría se reconstruye
  con la versión con que se hizo.
- **El senior.** `stuckSignals` y `followUpDue` (`lib/src/orchestra/reader.ts`) aceptan `vocabulary`: 1 por defecto, como
  siempre (una tabla es un experimento); 2 lee de la tabla común. `lab agent … --stuck-vocabulary 2` y la opción
  `stuckVocabulary` del operador agente. Los lotes, los equipos y el mundo vivo no la pasan todavía: usan la 1.
- **La memoria selectiva no cambia.** Su encabezado de cada paso (`memory.ts`) usa su propia lista auxiliar y es texto
  que el investigador ve al listar su memoria; unificarlo cambiaría ese texto para algunas peticiones.
- **Pruebas.** Las cinco `VM3:` de `lib/test/audit.test.ts` (aceptaciones 9 a 11, el recorrido de todos los
  laboratorios y los denominadores). El guion de reproducción añade A1, A2 y O1 leídos con `@2`.
- **Sin comprobar.** El recorrido de laboratorios saca las claves aceptadas leyendo el código de los reconocedores y del
  intérprete de actos del junior; una clave que se acepte de otra forma se le escaparía. Los actos de los demás mundos
  (`act` con sus campos) son experimentos sin distinguir tipos.

## 12. Aceptación

1. Un candidato con un ensayo resuelto y nueve `infra` no tiene calidad; con diez terminados y cinco resueltos, 0,5.
2. Un junior que no contesta dentro de su tiempo mientras el servicio responde tiene ese ensayo como no resuelto.
3. Dos políticas distintas nunca comparten fichero ni id de ensayo; una que colisiona con un fichero existente de otro
   contenido es un error.
4. Un manifiesto con el mismo mundo y argumentos en desarrollo y en confirmación se rechaza.
5. Un candidato que mejora un componente y empeora otro, protegido o no, más allá de su tolerancia es `not_promoted`.
6. Un manifiesto en el que ningún componente tiene casos para alcanzar su nivel se rechaza diciendo cuántos faltan.
7. Un dataset que comparte grupo con un caso de investigación se rechaza para entrenar; sus ejemplos se conservan.
8. La confirmación rechaza un paquete entrenado sin realizaciones declaradas, y uno cuyas realizaciones solapan las
   reservadas, sin decir cuáles.
9. Una prueba propia, un `wait` y un `edit` son experimentos para la auditoría; una petición sin clase impide cargar su
   laboratorio.
10. Los pasos de una ronda cerrada sin modelo quedan en el tramo de esa ronda.
11. La auditoría y las señales de atasco dan la misma clase a la misma petición.
12. Un check con un fallo del juez no consume ronda, no cambia papeles y se le dice al investigador como fallo del
    instrumento.
13. Ocho de ocho frente a cero de ocho, pareado, concluye «improves» si el margen lo permite; dos de dos, no concluye.
14. Una sesión compartida con un timeout registrado se reconstruye sin divergencia.
15. Los guiones que reprodujeron V1, V2, V3, V9, V10, V11 y V13 quedan como pruebas de la suite, fallando antes de
    cada entrega y pasando después.
