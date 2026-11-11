# PLAN · Arreglar la medida: trabajo para un modelo que empieza de cero

Estado (11/11/2026): **T0 a T8 hechas** (lo que quedó de cada una, en las notas «hecho» de SPEC-VALIDEZ-MEDIDA §11 y SPEC-CONSOLIDACION §8). Desarrolla [SPEC-VALIDEZ-MEDIDA.md](SPEC-VALIDEZ-MEDIDA.md) y, al
final, la primera entrega de [SPEC-CONSOLIDACION.md](SPEC-CONSOLIDACION.md). Los hallazgos que corrige (V1 a V19) están
en [REPASO-2026-11-10.md](REPASO-2026-11-10.md) §4.3. Está escrito para que un modelo sin contexto previo pueda tomar una
tarea, hacerla entera y dejarla comprobada.

## 1. Resultado que queremos

Que lo que juzga a un candidato (una política de investigación, un junior) no pueda dejarse engañar, antes de lanzar
ninguna ejecución real que seleccione o promueva algo. Al terminar las tareas T1 a T8:

- el guion `lib/scripts/validity-repro.ts` ya no reproduce ninguno de sus siete fallos, y cada uno es una prueba de la
  suite;
- la suite completa pasa y `tsc` pasa;
- ningún prompt que un investigador recibe ha cambiado, salvo donde la tarea lo dice.

Lo que **no** entra: lanzar ejecuciones con modelos reales, tocar los mundos, añadir capacidades, la fase B.

## 2. Reglas para quien lo ejecute

Léelas antes de la primera tarea. Valen para todas.

**Del proyecto (no se discuten):**

- Nunca leer, imprimir ni commitear claves. Los lanzadores de `lib/` ignorados por git (`lib/*.ps1`, `lib/*.sh` salvo
  los `.example`) pueden contenerlas: no se abren.
- Commit y push **sólo cuando el usuario lo pida**. Deja cada tarea lista para commit y dilo.
- Sin Docker, sin servicios que el usuario tenga que instalar, sin dependencias nuevas de ejecución.
- Lo que instales fuera del repo puede no existir en la máquina del usuario: no dependas de ello.
- `.claude/launch.json` no se commitea. Nada personal del usuario va al repositorio.
- Se responde al usuario en español. El código, sus comentarios y los mensajes de commit van en inglés, con el estilo
  que ya tienen (comentarios que explican el porqué; un commit es una línea larga que describe el cambio).

**De método:**

- **Primero la prueba que falla.** Cada tarea empieza escribiendo la prueba que muestra el fallo sobre el código
  actual, y se comprueba que falla por el motivo esperado antes de tocar nada.
- **Arregla el principio, no el caso.** Si el fallo es «un dato que falta favorece a alguien», se arregla donde se
  decide qué es un dato que falta, no con una excepción para el ejemplo.
- **Un formato que cambia de significado cambia de versión** (`paired-cases@2`, `method_audit@2`). Lo anterior se sigue
  leyendo; nunca se reinterpreta un registro ya escrito.
- **Los prompts no cambian** salvo donde la tarea lo pide expresamente. Si un cambio tuyo altera lo que recibe un
  investigador, es un error de la tarea: para y dilo.
- **Lo que no puedas comprobar, dilo así.** «Leído, sin ejecutar» es una respuesta válida; «debería funcionar» no.
- **No amplíes el alcance.** Lo que encuentres de paso se anota al final de tu informe como seguimiento.
- Si una tarea contradice su spec, manda la spec; si la spec es la que está mal, para y pregunta.

**Cómo se comprueba:**

```bash
cd lib && npx tsc -p tsconfig.json
```

```bash
cd lib && node --experimental-strip-types --no-warnings=ExperimentalWarning --test "test/<fichero>.test.ts"
```

```bash
cd lib && npm test
```

- La suite completa tarda varios minutos: lánzala en segundo plano. `artifact-world.test.ts` falla a veces bajo carga
  y pasa sola; si es la única que falla, reláncela aparte y dilo.
- Dos pruebas se saltan fuera de Linux: es lo esperado.
- En esta máquina la shell es Git Bash sobre Windows. Los heredocs con comillas fallan a menudo: escribe los ficheros
  con la herramienta de escritura, no con `cat <<EOF`.

**Qué entrega cada tarea:** el código, sus pruebas, la nota «hecho» en la spec (sección de entregas, con fecha, qué
quedó y dónde, como hacen las demás specs) y un informe de cinco líneas: qué cambió, qué prueba lo cubre, qué quedó
sin comprobar, qué seguimiento dejas.

## 3. Antes de empezar: T0

| | |
|---|---|
| **Qué** | Dejar el árbol limpio y la línea base medida |
| **Pasos** | 1. `git status`: hay cambios sin commitear de la segunda revisión de WE2–WE6 y los documentos del repaso. Pregunta al usuario si los commitea antes; no sigas sobre un árbol que mezcla trabajos. 2. Lanza `tsc` y la suite completa y guarda el resultado (número de pruebas, cuáles fallan). 3. Lanza `lib/scripts/validity-repro.ts` y guarda su salida: es el «antes» |
| **Hecho cuando** | Tienes por escrito la línea base y el usuario ha dicho qué hacer con lo pendiente |

## 4. Las tareas

Orden recomendado: T1, T2, T3, T4, T5, T6, T7, T8. T1, T2, T3 y T6 no dependen entre sí y pueden ir en paralelo si
cada una la lleva una sesión distinta: **no tocan los mismos ficheros**. T4 depende de T2. T5 toca el runner: una sola
sesión a la vez.

### T1 · El evaluador de ensayos no premia lo caído (VM1; hallazgos V1, V7, V8)

| | |
|---|---|
| **Ficheros** | `lib/src/meta/lab.ts`, `lib/src/meta/corpus.ts`, `lib/src/learn/law-session.ts` (sólo lo que registra `proposal_failed`), `lib/test/meta-lab.test.ts` |
| **Lee antes** | SPEC-VALIDEZ-MEDIDA §3; SPEC-METAPOLITICA-INVESTIGACION §8, §9, §11; `trialResult` (`lab.ts:128`), `Trials.one` (`:252`), `qualityOf` y `measureOf` (`:371`, `:383`), `manifestProblems` (`:55`) |

Pasos:

1. **Prueba:** un candidato con 1 ensayo resuelto y 9 `infra` no tiene calidad (`quality: null`, `complete: false`);
   con 10 terminados y 5 resueltos, 0,5. Hoy la primera da calidad 0.
2. `measureOf`: completa sólo si **todos** los ensayos necesarios están `ended`. `qualityOf` no cambia su cálculo; deja
   de usarse sobre evaluaciones incompletas.
3. **Las tres causas** (§3.1). `law-session.ts` registra con `proposal_failed` el estado HTTP, los milisegundos
   esperados y el tamaño de la petición (campos nuevos, nada más cambia). `trialResult` clasifica: 401/402/403/429/5xx y
   fallos de red son `infra`; un timeout del LLM en un ensayo donde otras peticiones al mismo servicio sí respondieron
   es **del candidato** y el ensayo es `ended`, no resuelto; lo indeterminado es `infra` y se cuenta aparte
   (`infra_indeterminate`).
4. **Reintentos:** `infra_retries` en el manifiesto (2 por defecto). Un ensayo `infra` cuyo run **terminó** no se
   reanuda: se lanza otro intento con otro nombre de registro (`<id>.a<k>.json`) y el anterior se conserva. Cada intento
   reserva y liquida.
5. **Identidades:** `manifestHash`, `trialId` y `policyFile` pasan a SHA-256 (24 hexadecimales en nombres). `policyFile`
   compara el contenido si el fichero existe y lanza un error si difiere. El libro de ensayos escrito con ids antiguos
   se sigue leyendo: `recordOf` y la búsqueda de `finished` aceptan los dos mientras existan.
6. **Particiones:** `manifestProblems` rechaza dos casos con el mismo `lab` y los mismos `args` en particiones
   distintas. `partition` de `corpus.ts` une en un linaje los runs con `--experience` de otro y los miembros de un
   equipo.
7. La tasa de `infra` por candidato va en el `feedback` de la evaluación.
8. `verifyTrials` tolera una última línea cortada, como `ledger()`.

Hecho cuando: las pruebas nuevas pasan; `meta-lab.test.ts` pasa entero; la aceptación 1 a 4 de la spec se cumple; el
bloque `M1` del guion de reproducción da `quality: null` para el superviviente.

Cuidado: `Trials` también evalúa juniors (`lib/src/junior/trials.ts`). Lanza `lib/test/junior-*.test.ts` después.

### T2 · La promoción no deja empeorar y dice si puede decidir (VM2; V2, V3, V4)

| | |
|---|---|
| **Ficheros** | `lib/src/junior/competence.ts`, `lib/src/junior/evaluate.ts`, `lib/src/junior/confirm.ts`, `lib/src/junior/comparison.ts` (sólo cómo llama al veredicto), `lib/test/junior-competence.test.ts` |
| **Lee antes** | SPEC-VALIDEZ-MEDIDA §4; SPEC-METAPOLITICA-APRENDIZAJE §6.5, §9; `promote` (`competence.ts:379`), `signFlipP` (`:336`), `competenceProblems` (`:128`) |

Pasos:

1. **Pruebas:** (a) un candidato que mejora «formato» y pasa «mundos» de déficit 0 a 1, sin proteger, es
   `not_promoted`; (b) un manifiesto en el que ningún componente tiene casos para alcanzar `alpha / K` se rechaza
   diciendo cuántos faltan; (c) uno en el que sólo algunos no pueden, se acepta con aviso.
2. `paired-cases@2`: el manifiesto elige el procedimiento (`promotion.procedure`). `@1` sigue funcionando igual para
   leer y recomprobar lo ya medido. En `@2`:
   - todo componente bloquea si su media cae más que su tolerancia; `protected` pone la tolerancia a cero salvo que
     declare otra;
   - bloquea también si la caída es significativa con el mismo test, en el otro sentido;
   - cada componente del veredicto lleva `min_p` (2⁻ⁿ) y `n`.
3. `competenceProblems` devuelve hoy una lista de errores. Añade una función hermana `competenceWarnings(m)` para lo que
   no impide correr. El caso «ninguno puede mejorar» es error.
4. `ConfirmationService` aplica lo mismo a su manifiesto al construirse.
5. **La parte apartada:** `holdout` en el manifiesto: ids de casos de sonda que una búsqueda no usa para seleccionar.
   `probesOf` y el evaluador de la búsqueda los excluyen; la promoción «por regla» de un candidato salido de una
   búsqueda se hace **sólo** con ellos. Sin `holdout`, `comparison.ts` informa «el mejor de N en selección» y no
   «promovido».

Hecho cuando: aceptación 5 y 6; los bloques `J1` y `J2` del guion cambian como se espera (J2 no cambia de números: lo
que cambia es que el manifiesto lo avisa); `junior-weight-*.test.ts` siguen pasando.

Cuidado: no cambies el significado de `@1` ni los veredictos ya escritos en registros de prueba.

### T3 · Un vocabulario de peticiones, y la auditoría que lo usa (VM3; V9, V10, V11)

| | |
|---|---|
| **Ficheros** | nuevo `lib/src/learn/requests.ts`; `lib/src/audit/links.ts`, `audit.ts`; `lib/src/orchestra/reader.ts`; `lib/src/learn/assisted/memory.ts`; `lib/src/learn/lab.ts` (un campo opcional); `lib/test/audit.test.ts` |
| **Lee antes** | SPEC-VALIDEZ-MEDIDA §6; SPEC-AUDITORIA-METODO §3 a §5; `links.ts:26-28`, `:240-283`; `reader.ts:59` y `stuckSignals`; `LivingBridge.accepts` (`living/bridge.ts:87`) |

Pasos:

1. **Pruebas:** una prueba propia (`test`), un `wait` y un `edit` son experimentos; los pasos de una ronda cerrada con
   `round_closed` quedan en el tramo de esa ronda; auditoría y `stuckSignals` dan la misma clase a la misma petición.
2. `requests.ts`: la tabla de §6.1 con las peticiones comunes, una función `kindOf(request)` (una sola forma de sacar
   la clave) y `classOf(request, lab)`. Un laboratorio declara las suyas en `Lab.requests?` (opcional; los actos del
   mundo del junior y del mundo vivo se declaran ahí).
3. Una prueba recorre todos los laboratorios y falla si alguno acepta una petición sin clase. Para saber qué acepta
   cada uno, parte de `act.examples`, `LivingBridge.accepts`, `Delegations.accepts`, `JournalMemory.accepts` y los
   reconocedores de `assisted/session.ts:365`.
4. `links.ts` clasifica con la tabla. `round_closed` cierra tramo; `consolidated` se anota en el tramo. Un cierre sólo
   cita pasos anteriores a él en el orden de los eventos (hoy `later` usa `round >=`).
5. `reader.ts`: `stuckSignals` y `followUpDue` leen de la tabla. `table` y `measure` pasan a observación **tras una
   opción** (`--stuck-vocabulary 2`); por defecto el senior se comporta como hoy. No cambies ninguna condición ya
   medida.
6. `audit.ts`: `method_audit@2`; cada reparto lleva su denominador y cuántos enlaces quedaron sin juzgar. La
   calibración (`calibration.ts`) rechaza mezclar `@1` y `@2`.

Hecho cuando: aceptación 9 a 11; `audit*.test.ts` y `orchestra*.test.ts` pasan; los bloques `A1`, `A2` y `O1` del
guion dan lo esperado.

Cuidado: `links.ts` lee sólo lo que el investigador vio. No añadas nada del registro del operador.

### T4 · Una sola regla para separar los datos (VM4; V5, V6)

| | |
|---|---|
| **Depende de** | T2 |
| **Ficheros** | nuevo `lib/src/junior/groups.ts`; `distill.ts`, `weight-lab.ts`, `train.ts`, `package.ts`, `confirm.ts`; `lib/src/worlds/junior/lab.ts` (donde se escribe la procedencia); pruebas `junior-distill*`, `junior-confirm*` |
| **Lee antes** | SPEC-VALIDEZ-MEDIDA §5; SPEC-EDICION-PESOS §4.1 (E3); `selectionOverlap` (`distill.ts:186`), `weightLabProblems`, `owes` e `importPackage` en `confirm.ts` |

Pasos:

1. **Pruebas:** un dataset que comparte grupo con un caso de investigación se rechaza para entrenar y sus ejemplos se
   conservan; la confirmación rechaza un paquete entrenado sin realizaciones, y uno cuyas realizaciones solapan sus
   casos, sin decir cuáles.
2. `groups.ts`: `usesOf(manifest)` devuelve, por grupo, sus usos. `selectionOverlap` y `weightLabProblems` pasan a
   usarla; el comportamiento del laboratorio de pesos no cambia, el de la destilación se endurece.
3. `provenance.realizations` en el paquete: una lista de `{ lab, args_hash }`, escrita por el mundo al entrenar, editar
   con un constructor alimentado por el laboratorio, o destilar. **No entra en el hash de ejecución** (compruébalo en
   `executionHash`: la procedencia ya está fuera). Un paquete sin adaptador ni ediciones no la necesita.
4. `ConfirmationService.confirm` compara esas realizaciones con las de sus casos reservados antes de evaluar.

Hecho cuando: aceptación 7 y 8; toda la batería `junior-*.test.ts` pasa.

Cuidado: los paquetes de las pruebas existentes no llevan realizaciones. Un paquete **sin** entrenamiento ni ediciones
debe seguir confirmándose igual.

### T5 · Un check sin juez no es un veredicto (VM5; V12, V14, V18)

| | |
|---|---|
| **Ficheros** | `lib/src/learn/protocol.ts`, `lib/src/learn/objective.ts`, los `objective.ts` de los mundos que capturan el error por punto (empieza por `worlds/cells/objective.ts:91`), `lib/src/learn/law-session.ts`, `lib/src/orchestra/results.ts`, `lib/src/runtime/lab-runner.ts` (lo mínimo) |
| **Lee antes** | SPEC-VALIDEZ-MEDIDA §7; SPEC-CALIBRACION-INSTRUMENTOS §4, §5; `Protocol.checkIn` y `round`; `core/evaluate.ts:164-185`; `core/formula.ts:84-97` |

Pasos:

1. **Antes de nada, mide el alcance.** Yo lo leí sólo en `cells`. Recorre cada objetivo de mundo y anota cómo trata un
   error del juez en un punto. Escribe la tabla en tu informe. Si algún mundo ya lo trata bien, tómalo de modelo.
2. **Prueba**, con un juez sustituto que falla en un punto: el check no consume ronda, no cambia el papel de ningún
   lugar, no entra en la regresión pareada, y lo que recibe el investigador dice que el instrumento falló.
3. Distingue en el resultado de un punto «el modelo no pudo responder» (su código lanzó: cuenta contra él, como hoy) de
   «el juez no respondió» (nulo). Hace falta un tipo de error propio que el evaluador lance cuando falla el juez.
4. El protocolo reintenta una vez con los mismos casos; si vuelve a fallar, devuelve la ronda. Se registra un evento
   `check_void`.
5. `compose` no cambia (lo usa la búsqueda que juega). En un check, una regla sin respuesta deja el punto sin medir.
6. `law-session.ts:282-292`: un error transitorio del LLM se reintenta aparte (máximo propio, 2) y no consume las tres
   negativas. Los 401/402/403 siguen siendo fatales.
7. `runResults`: `model` es `boolean | null`; `null` si falta el hallazgo. Revisa quién lo consume (`meta/lab.ts`,
   `meta/corpus.ts`, `control-chart.ts`, `references.ts`).

Hecho cuando: aceptación 12; la suite entera pasa. **Esta tarea sí cambia lo que un investigador recibe** en un caso:
cuando el juez falla. Enséñale al usuario el texto exacto antes de darlo por bueno; debe ser un hecho, sin análisis.

Cuidado: el evento nuevo debe reproducirse al reanudar (`replay.ts` ya registra los fallos del juez). Añade una prueba
de reanudación que pase por un check nulo.

### T6 · La comparación pareada concluye cuando hay separación (VM6, parte; V13)

| | |
|---|---|
| **Ficheros** | `lib/src/runtime/statistics.ts`, su prueba |
| **Lee antes** | SPEC-VALIDEZ-MEDIDA §8; SPEC-CONTROL-ARNES §6.2.1 |

Pasos: prueba (8 de 8 frente a 0 de 8 concluye «improves» con margen 0,2; 2 de 2 no concluye; 4 mejores y 4 peores,
«insufficient evidence»). Con resultados binarios y todas las diferencias iguales y distintas de cero, usa el test de
signos exacto sobre los pares discordantes: p bilateral frente a 0,05 y efecto frente al margen. Actualiza el texto de
`rule`. Los casos continuos no cambian.

Hecho cuando: aceptación 13; `results.test.ts` y las pruebas de lotes pasan.

### T7 · Lo operativo (VM6, resto; V15 a V19)

| | |
|---|---|
| **Ficheros** | `lib/src/living/world.ts`, `run-session.ts`, `bridge.ts`, `record.ts`; `lib/src/orchestra/agent-operator.ts` |

Pasos, cada uno pequeño e independiente:

1. **V15, primero la prueba.** Una sesión con dos investigadores y `window_ms` en la que uno consta como ausente en
   una ventana; reconstrúyela con `rebuildLivingSession`. Si diverge, arréglalo: al reconstruir, el miembro que el
   registro da por ausente en la ventana *n* se sella vacío en ella aunque su respuesta llegue antes. Si **no**
   diverge, el hallazgo era falso: deja la prueba, dilo, y corrige el repaso.
2. **V17:** el fallo de un senior en una sesión viva se escribe en el registro de la sesión; deja de tragarse.
3. **V16:** una lectura del diario que no parsea se reintenta (3 veces, 50 ms) antes de tratarse como «sin diario».
4. **V19:** `plate`, `layout` y `well` salen de la capa genérica: el adaptador nombra su vista. Esto cambia una clave
   de lo que recibe el investigador en `plates@1`: consérvala idéntica para ese mundo.
5. `living/external.ts`: pregunta al usuario si se cablea o se archiva; no decidas tú.

Hecho cuando: aceptación 14; `living-*.test.ts` pasan.

### T8 · Las pruebas quedan, y el diario deja de ser frágil

1. Convierte cada bloque de `lib/scripts/validity-repro.ts` en una prueba de la suite (si T1 a T6 no lo hicieron ya) y
   borra el guion. Aceptación 15.
2. Empieza SPEC-CONSOLIDACION **CC1 sólo en su parte de escritura** (§3.2): el diario se añade por líneas y
   `<run>.json` se escribe a un temporal y se renombra. El esquema de eventos (§3.1) es otra tarea, no ésta.
3. Lanza la suite completa y `tsc`. Compara con la línea base de T0.

## 5. Qué decide cada tarea para la campaña

| Antes de | Hace falta |
|---|---|
| Etiquetar la muestra de la auditoría (E1 del repaso) | T3 |
| Repetir los hallazgos del README (E2) | T5, T6 |
| Lanzar el piloto de la metapolítica (E5) | T1 |
| La línea base de la fase A (E6) | T2, T4 |
| La comparación A–F (E7) | T2 con `holdout` |

## 6. Lo que queda fuera y por qué

- **Leer lo que no se leyó** (`orchestra/project.ts`, `references.ts`, `traces.ts`, `launch.ts`, `learn/assisted`, el
  cuerpo de `runLawLab`, los mundos, los trabajadores de Python). Es una tarea aparte, de sólo lectura, que puede
  correr en paralelo y debe producir hallazgos con fichero y línea, comprobados donde se pueda, en el formato de
  REPASO §4.3.
- **El resto de SPEC-CONSOLIDACION y SPEC-CONTINUIDAD-CONTEXTO:** después de esta tanda.
- **Cualquier ejecución con modelos reales:** la lanza el usuario.

## 7. Riesgos del plan

- **T5 es la más delicada:** toca el protocolo, que es lo que más pruebas cubren y lo que decide una aceptación. Si el
  alcance medido en su paso 1 es mayor de lo esperado, parte la tarea por mundos.
- **T1 y T2 cambian resultados de pruebas existentes** que hoy afirman el comportamiento antiguo. Cada prueba que
  cambies, di por qué en el informe: una prueba no se edita para que pase.
- **T3 puede descubrir peticiones que nadie clasificó.** Clasifícalas tú con el criterio de la tabla y lista las
  dudosas para el usuario.
- **Los hallazgos «leídos» pueden ser falsos.** V5, V6, V12 y V15 no se ejecutaron. La primera prueba de cada tarea es
  también la comprobación del hallazgo.
