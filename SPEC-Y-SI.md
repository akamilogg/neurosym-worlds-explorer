# SPEC · «¿Y si…?»: primitivas para abrir una dirección de investigación

Estado (21/10/2026): **sustituido; no es un contrato vigente**.
La propuesta vigente es [SPEC-DELEGACION-INVESTIGACIONES.md](SPEC-DELEGACION-INVESTIGACIONES.md).
Su implementación elimina la herramienta aquí descrita y sus superficies exclusivas, sin compatibilidad,
migración ni conservación de runs: no se han realizado runs con ella. El contenido siguiente queda como antecedente
de diseño, no como requisitos para implementar o mantener.
Refinamiento: política neurosimbólica opcional para decidir cuándo cerrar una ronda o solicitar una nueva dirección;
Jev es un candidato para sus juicios semánticos. System 2 genera las hipótesis. La política puede ser un artefacto
que el investigador revise con experiencia. El [plan de implementación](PLAN-Y-SI.md) concreta el modo autónomo.
Esta es la propuesta de implementación acotada. `SPEC-GENERACION-HIPOTESIS.md` queda como investigación de referencia;
sus componentes adicionales no son requisitos de esta entrega.

La delegación sustituye estas primitivas; no se conservan como modalidad ligera.

## 1. La idea

El investigador observa su propio recorrido: «Estoy ajustando detalles, pero no entiendo mejor lo que ocurre» o
«Esta explicación necesita demasiadas piezas sin comprobar». Puede entonces pedir:

- **Un giro:** «¿Y si…?». Una relación o supuesto distinto que abra una dirección.
- **Una bifurcación:** «¿Y si fuera A, o si fuera B?». Dos explicaciones que difieran en algo decisivo y ayuden a
  decidir hacia dónde mirar.

El modelo propone una semilla. El investigador decide si merece seguirla y usa sus herramientas para hacerlo.
No se pide una solución completa, código, un plan de investigación ni una hipótesis formal antes de explorar la idea.

**El bucle es: valorar el recorrido → pedir una dirección → explorarla → aprender de lo que pasó.**
El arnés ofrece las primitivas y conserva las interacciones. Opcionalmente evalúa una política explícita que recomienda
o ejecuta cierres y solicitudes de dirección, según el modo declarado para el run. Sin habilitarla, el control sigue
en el investigador. La política no modifica los criterios de aceptación del mundo.

## 2. Dos formas de una misma herramienta

Disponible siempre para el investigador asistido, en sus dos hemisferios (§8.3), dentro de `investigate`; `--no-what-if` la quita a los dos. API propuesta:

```json
{
  "investigate": [{
    "what_if": {
      "mode": "turn",
      "situation": "He probado varias correcciones, pero el mismo error reaparece tras cada pulso.",
      "question": "¿Y si el error no estuviera donde estoy intentando corregirlo?",
      "refs": ["model:r4", "investigation:r4.2"]
    }
  }]
}
```

`mode` es `turn` o `fork`. `situation` es la síntesis y valoración del propio investigador; `question` y `refs` son
opcionales. Las referencias son objetos de su memoria accesibles en ese momento, no rutas arbitrarias.
También puede pedir un giro sin estar atascado: descubrir cuándo resulta útil forma parte del aprendizaje.

Respuestas breves, ilustrativas:

```json
{
  "id": "what_if:r5.1",
  "mode": "turn",
  "idea": "¿Y si el error fuera una huella de memoria del sistema, y no un coeficiente mal ajustado?"
}
```

```json
{
  "id": "what_if:r5.2",
  "mode": "fork",
  "a": "La dependencia del pasado está en el sistema: cambiar su historia cambia la respuesta real.",
  "b": "El sistema no tiene esa memoria: la dependencia aparece en el instrumento que lo mide.",
  "difference": "¿La dependencia sigue al sistema o a la medición cuando logras variar uno sin el otro?"
}
```

En `fork`, la instrucción pide alternativas incompatibles en una premisa explícita, no dos redacciones parecidas.
Son direcciones provisionales: no se afirma que agoten las posibilidades. En el ejemplo ambos efectos podrían
coexistir y requerir una tercera explicación. `difference` puede señalar una observación útil sin diseñar todo el
experimento. Si el modelo no encuentra una distinción defendible, devuelve `no_direction` con una razón breve.

No hay puntuación de novedad ni veredicto de verdad. Una respuesta puede ser vaga o equivocada; el investigador
puede desarrollarla, reformularla, ignorarla o dejarla pendiente. El arnés solo comprueba la forma de la respuesta.

## 3. Qué hace la llamada

1. El runner entrega al proponente `situation`, `question`, el modo y el contenido de las referencias autorizadas.
2. El proponente recibe una instrucción breve: ofrecer una nueva dirección respecto al recorrido descrito; puede
   relacionar otros dominios si eso aporta una diferencia útil. Devuelve un giro o una bifurcación, sin resolverla.
3. La respuesta vuelve al investigador como resultado de herramienta, identificada como sugerencia generada.
4. La investigación continúa con las herramientas habituales. No se ejecutan acciones ni se modifican modelos
   como efecto de la sugerencia.

El proponente no recibe el diario completo ni tiene acceso directo al mundo, al filesystem o a sus evaluadores.
El contexto lo elige el investigador. Referencias no autorizadas, ausentes o demasiado grandes producen un error
explícito para que reduzca su selección; no se resume ni se recorta silenciosamente.

Primera implementación: una llamada aislada a un LLM, que puede ser el mismo modelo del investigador. No requiere
otro agente persistente ni un senior. Un backend NCP o de difusión podrá usar el mismo contrato si demuestra que
puede producir estas respuestas; no es requisito para probar la primitiva.

### 3.1 Política opcional de disparo

**Cuándo pedir una dirección** y **cómo formular la solicitud** son decisiones distintas. La política ayuda con la
primera. En uso manual, el investigador escribe `situation` y elige referencias; en automático se entrega a System 2
la razón de la decisión, las notas recientes y la ventana visible declarada. El investigador decide cómo explorar la respuesta.
Así se puede distinguir una llamada inoportuna de una solicitud mal formulada o una dirección poco útil.

La política observa una ventana declarada del recorrido visible al investigador. Combina hechos calculados con
juicios semánticos acotados:

| Señal | Quién la obtiene |
|---|---|
| Pasos transcurridos, gasto y última llamada a `what_if` | Código sobre el registro |
| Los intentos recientes son ajustes de la misma explicación | Regla semántica evaluada por Jev |
| Persiste la misma incertidumbre pese a esos intentos | Regla semántica sobre preguntas, acciones y resultados visibles |
| Hay una prueba pendiente que podría discriminar alternativas | Regla semántica sobre el plan registrado |
| Existen alternativas con consecuencias distintas que aún no se han contrastado | Regla semántica evaluada por Jev |
| Hay presupuesto para llamar y desarrollar una propuesta | Límites y reserva calculados por código |

Jev no decide si la explicación científica es verdadera. Juzga aspectos concretos del recorrido; la composición
produce `continue`, `close_round`, `turn`, `fork` o `abstain`. Sus valores no son probabilidades calibradas de estar
atascado. Si falta contexto o falla un juicio necesario, la evaluación se abstiene; ausencia de evidencia no vale cero.

Ejemplo de política inicial, para probar y modificar, no regla universal:

```text
Si persiste la incertidumbre, los intentos repiten el enfoque
y no hay una prueba discriminante pendiente:
    sugerir un giro.

Si hay alternativas con consecuencias distintas,
pero se sigue ajustando sin buscar esa diferencia:
    sugerir una bifurcación.

Si no hay contexto suficiente:
    abstenerse.
```

La versión concreta declara umbrales, combinación y precedencia cuando se cumplen varias reglas. No se fija una suma
ponderada obligatoria. Se reutiliza la separación de la librería entre observaciones, reglas y `output`: un adaptador
presenta el recorrido como entrada, Jev juzga las reglas y código compone una salida validada. La política es un
artefacto distinto del modelo del mundo; cambiar una no altera el otro ni sus criterios de aceptación.

Modalidades: **recomendación** y **automática**, además de desactivada. Se evalúa tras completar y registrar un lote
de herramientas con evidencia nueva, antes de la siguiente consulta del investigador. La ventana, frecuencia y
separación mínima entre disparos quedan declaradas. En recomendación, el aviso muestra qué reglas lo motivaron y
qué tramo se examinó; el investigador puede ignorarlo. Una recomendación no dispara otra evaluación de sí misma.

En automático, `close_round` cierra sin propuesta; `turn` y `fork` cierran y solicitan una dirección para la siguiente
ronda si queda presupuesto. Se resuelven primero las pruebas pendientes conforme a sus límites y se incluyen sus
resultados visibles en la solicitud. Se conservan modelos, memoria, contraejemplos y gasto; no se reinician validaciones.
Cerrar una ronda no termina el run. Los fallos y abstenciones dejan el control habitual al investigador.

Sin política, las llamadas manuales funcionan como antes. Incluso con política, `continue` o `abstain` no prohíben
pedir ayuda manualmente. Al comparar modos se declara cómo se construye la solicitud automática, para no atribuir
al disparador una mejora que provenga de cambiar el contexto o la formulación.

### 3.2 Aprender la política

El investigador puede proponer otra versión de sus observaciones, preguntas semánticas, umbrales o composición tras
examinar varios runs. Por ejemplo: distinguir calibración lenta de estancamiento, esperar una prueba ya prevista o
detectar antes una sucesión de ajustes equivalentes. No hace falta un optimizador externo para redactar esas versiones.

Cada versión conserva padre, motivo y contenido. El operador elige cuál habilita el siguiente run. Para comparar
políticas se congelan sus versiones durante cada run y se mantienen proponente y formulación comparables. Una
modificación durante una investigación se registra como otra condición adaptativa, no como la política congelada.

Se aprende si la política ayuda a investigar en mundos reservados, no si coincide con otro juez que opine cuándo
debería disparar. Continuar sin aviso también puede ser un error de la política: conservar todas las evaluaciones,
no solo las que recomiendan llamar. La experiencia permite revisar tanto disparos prematuros como oportunidades
perdidas; una sola trayectoria no demuestra qué habría pasado siguiendo otro rumbo.

## 4. Encaje en la librería

| Pieza existente | Cambio necesario |
|---|---|
| `learn/assisted/` | Un módulo `what-if.ts` para validar la petición, construir la llamada y leer la respuesta |
| Prompt y despacho de `investigate` | Exponer `what_if` cuando esté habilitado y dirigir las peticiones al módulo |
| `LabServices` y runtime | Inyectar el proponente, grabar la llamada y contabilizar su consumo |
| Observaciones, reglas y `output` del núcleo | Adaptador opcional para evaluar la política de disparo sobre el recorrido |
| Memoria de investigaciones | Conservar petición y respuesta como otro paso recuperable |
| Cuaderno, `methods` y experiencia | Sin otro almacén: el investigador escribe lo que aprende sobre el uso de la herramienta |

La lógica es común, sin conocimiento de leyes particulares. La primera entrega cubre los mundos que usan el bucle
común de leyes. Los bucles propios, como cuadrícula, requieren conexión explícita antes de anunciar soporte.
Si no está habilitada, no aparece en el prompt y una llamada se rechaza. El investigador puro permanece igual.

Cada petición consume un paso de investigación y una llamada del presupuesto configurado para esta herramienta;
sus tokens y tiempo se incluyen en el coste total del run. El operador fija límites de llamadas, salida y tiempo,
y el backend usado. No hay cuota metodológica obligatoria ni llamadas gratuitas ocultas. Si se declara presupuesto
adicional, el resultado lo identifica como ayuda con recursos extra.

Evaluar la política también cuesta: registrar por separado sus llamadas a Jev, consumo informado y tiempo, e incluirlos
en el presupuesto total. Si se agota su límite, se informa que la política no fue evaluada; no se simula `continue`.
Las observaciones solo leen el contexto autorizado y su código usa el sandbox existente. Antes de invocar a Jev,
comprobar permisos, límites y disponibilidad del contexto; esos controles no pueden relajarse editando la política.

La configuración y la versión de la instrucción quedan en el registro. Guardar petición resuelta, respuesta completa,
fallos y consumo conocido. El replay devuelve lo grabado sin volver a consultar al modelo. La identidad de la llamada
la asigna el runner; reanudar no duplica la operación. Un timeout o respuesta inválida queda registrado y no dispara
reintentos ilimitados. Nunca entran verdad oculta, informes exclusivos del operador ni casos ciegos.

Para cada evaluación de política conservar versión, ventana y entradas exactas, juicios, salida de la composición,
aviso emitido y llamada posterior si la hubo. Cachear juicios solo con identidad de entrada, regla y configuración
del juez compatibles. El replay conserva también recomendaciones y abstenciones sin consultar de nuevo a Jev.

## 5. Cómo aprende el investigador a utilizarlas entre mundos

Lo que se quiere aprender es **cuándo pedir ayuda, cómo formular la situación, qué contexto aportar, cuándo pedir
un giro o una bifurcación y cuánto merece desarrollar la respuesta**. No se prescribe esa política de antemano.

Un recorrido inicial:

1. Investigar varios mundos con la herramienta disponible. El investigador elige si usarla.
2. Conservar íntegros los runs. Puede anotar en `methods` qué usos abrieron camino, cuáles repitieron lo sabido y
   cuáles desviaron la atención. Estas notas son su interpretación, no una conclusión del evaluador.
3. Lanzar otra investigación con acceso documental a esos runs mediante `experience`, sin resumen obligatorio.
   El investigador consulta lo que necesita y puede revisar su forma de usar las primitivas.
4. Probar el método adquirido en mundos reservados. Comparar el resultado con la misma configuración sin esa
   experiencia, conservando los fallos y el coste de aprender.

Para estudiar transferencia entre dominios se usa `transfer`. Para estudiar investigaciones previas de un mismo
mundo se declara `meta`. `scope: methods` permite ensayar transferencia de método; `all`, acceso al trabajo completo.
Una nota de método también puede contener pistas del dominio: el nombre del scope no garantiza aislamiento, y las
familias reservadas y la revisión de la información transferida deben respetar esa separación.

Esto es aprendizaje mediante experiencia consultable, **no actualización automática de pesos**. No hace falta un
«mundo generador de hipótesis» nuevo: primero se puede investigar el uso de la herramienta dentro de varios mundos
existentes. La política neurosimbólica puede ser otro resultado explícito de ese aprendizaje (§3.2). Un optimizador
externo que busque políticas automáticamente sigue siendo una ampliación posterior, separada de este alcance.

## 6. Prueba pequeña para decidir si sirve

Primero comprobar el recorrido con un proponente simulado. Después elegir dos mundos soportados y reservar tareas
o familias para una prueba posterior. Mantener modelo, configuración y oportunidades de evaluación comparables.

| Condición | Qué permite contrastar |
|---|---|
| Sin `what_if` | Referencia de la investigación habitual |
| Con `what_if`, sin experiencia previa | Utilidad inicial de las primitivas |
| Con `what_if` y experiencia de uso | Si el investigador aprende a aprovecharlas en tareas nuevas |

Después, comparar decisión libre frente a recomendación de una política congelada, con el mismo proponente y
presupuesto total, incluido Jev. Comparar una versión inicial con otra aprendida en mundos de desarrollo y congelada
antes de evaluar en mundos reservados. No cambiar a la vez disparador, proponente y experiencia sin distinguir sus
efectos. Puede añadirse un disparador sencillo por número de rondas para comprobar si los juicios semánticos aportan.

Comparar bajo presupuesto total equivalente, incluyendo las llamadas del proponente. Si aparece una mejora, añadir
un control de «revisa tu enfoque» con recursos equivalentes para distinguir el valor del giro de simplemente pensar
más. Declarar mundos, semillas, presupuestos y criterio de comparación antes de correrlos. Un piloto pequeño orienta
la siguiente prueba; no demuestra generalización.

El éxito principal sigue siendo el del mundo, con sus evaluaciones habituales. Para entender qué pasó, seguir unas
preguntas concretas en el registro: ¿la sugerencia cambió la dirección?, ¿motivó una observación que distinguió
explicaciones?, ¿permitió abandonar una vía improductiva?, ¿solo produjo más texto o distracción?
Son lecturas respaldadas por pasos del run, no recompensas automáticas. Una idea refutada puede haber sido útil.
Contar llamadas o valorar lo sorprendente que suena la respuesta no mide su utilidad.

## 7. Cuándo está terminada la primera entrega

- Un investigador asistido puede pedir ambos modos y continuar con sus herramientas normales en los mundos soportados.
- Una referencia prohibida se rechaza; el proponente solo recibe la vista autorizada.
- Petición, respuesta, errores y coste quedan recuperables; el replay funciona sin inferencia nueva.
- Límites, cancelación y reanudación no producen gasto o llamadas sin registrar.
- La experiencia de otro run permite recuperar esos pasos y los métodos escritos por su investigador.
- Ninguna respuesta de `what_if` altera el veredicto, obliga a cambiar de rumbo o se convierte en evidencia del mundo.

La política es una entrega opcional encima de las primitivas. Para darla por terminada:

- Los hechos, juicios y composición se pueden inspeccionar por separado, ligados a una versión de política.
- Falta de contexto, fallo del juez y límite agotado se distinguen de una decisión válida de continuar.
- Una recomendación puede ignorarse; no se repite sin respetar la frecuencia y separación declaradas.
- En automático, el cierre conserva el estado, atiende las pruebas pendientes y puede abrir otra ronda sin propuesta ficticia.
- Los giros automáticos son solicitudes a System 2; no cambian el modelo ni validan hipótesis por sí mismos.
- Juicios y recomendaciones entran en replay y presupuesto; una edición no altera decisiones pasadas.
- Las versiones propuestas por el investigador pueden compararse en varios mundos sin cambiar el modelo del mundo.

No incluye un detector universal de estancamiento, grafo nuevo de conceptos, jueces de creatividad, entrenamiento de
modelos ni orquestación adicional. La pregunta experimental es: **¿estas dos formas de pedir una nueva dirección
ayudan, y puede el investigador aprender una política interpretable para utilizarlas mejor entre mundos?**

## 8. Conciliación con la librería y con las bases del proyecto (19/10/2026)

Revisión del spec y del [plan](PLAN-Y-SI.md) contra el código hasta `ca393ab` y contra los principios del proyecto. La idea
encaja, y casi todo lo que necesita ya existe. Lo que sigue precisa el encaje, añade lo que falta y propone un cambio de
orden.

### 8.1 Lo comprobado en el código

- **El diagnóstico del plan (§3) es correcto.** En `lab-runner.ts`, `session.consult('propose')` devuelve `null` también
  cuando no hay propuesta, y el bucle hace `continue`. `ownTests.runPending` sólo corre si hubo propuesta. Un cierre
  voluntario hoy no se distingue de «no propuso», y las pruebas pendientes se posponen.
- **Los ids de las referencias ya son los de la memoria del investigador** (`assisted/memory.ts`): `model:r<n>`,
  `investigation:r<n>.<k>`, `note:<id>` y demás. `refs` debe aceptar exactamente esos y resolverlos con la misma memoria,
  sin otro índice.
- **El núcleo que reutiliza la política existe:** `core/formula.ts`, `observer.ts`, `output.ts`, `jev.ts` y también
  `policy.ts`.
- **El replay no necesita nada nuevo.** Una llamada aislada con el mismo cliente de System 2 pasa por el canal `llm` de
  `ReplayLog` y queda grabada al llegar. La identidad la da la propia petición, no hace falta que el runner la asigne.
  `lab verify` la reconstruye sin red, como cualquier otra. Las llamadas de la política a Jev van por el canal `jev`,
  igual.
- **Lo que aprende el investigador ya tiene sitio:** `--experience` en sus modos `transfer` y `meta` con `scope`, la
  memoria selectiva y `methods`. Si cada `what_if` se registra como un paso de `investigation`, es recuperable sin otro
  almacén.

### 8.2 Invariantes del proyecto que el spec no menciona y debe cumplir

1. **Capacidades con fecha.** Cada sección nueva del prompt (la herramienta `what_if`, la acción de cerrar ronda, los
   avisos de la política) entra en `CAPABILITIES` (`learn/lab.ts`) y se activa con `capabilities_from`. Si no, un run
   anterior reanudado o verificado (`lab verify`) recibiría otro prompt y divergiría.
2. **La conversación sólo crece** (`test/append-only.test.ts`), **con el sistema fijo** (`fixed_system`).
   - La herramienta, si está habilitada, se describe en el sistema desde la primera pregunta, nunca a mitad de run.
   - La respuesta de `what_if` vuelve como resultado de su paso, como cualquier otro.
   - Las recomendaciones de la política y las direcciones automáticas llegan como **mensajes nuevos del canal**
     (SPEC-CANAL-MENSAJES), marcados con su remitente y la versión de la política. Nunca reescriben un mensaje ni el
     sistema.
3. **El presupuesto visible.** El investigador ve `rounds_left` y `help_left`. Si `what_if` tiene un límite propio, lo ve
   igual (`what_if_left`). Pedir una dirección sin saber cuántas quedan contradice SPEC-INVESTIGADOR-ASISTIDO §15.
4. **La identidad del generador** (SPEC-RIESGO-MODELOS §8.2; SPEC-CONTROL-ARNES §6.1). La configuración de `what_if`
   (modo, límites, versión de la instrucción) y la política (modo, versión, hash de su artefacto) van en la configuración
   del diario. Así `generatorOf` separa las condiciones, y un run con política nunca se agrega con uno sin ella.

### 8.3 Solapamientos que conviene resolver reutilizando

- **`what_if` es una herramienta del investigador, no de una de sus mitades.** Junior y senior son los dos hemisferios
  de un mismo investigador que trabaja en el mismo problema (SPEC-ORQUESTADOR §3.3): el operativo, que actúa sobre el
  mundo, y el estratégico, que piensa por delante. Los dos pueden pedir un giro o una bifurcación.
  - **El senior** la tiene entre sus instrumentos, junto a los de lectura de memoria. Sus `refs` pueden ser del registro
    del junior (`model:r<n>`, `investigation:r<n>.<k>`...) o del suyo (`my_note:<id>`, `my_decision:<n>`...), con el mismo
    aislamiento: el proponente sólo recibe lo que cita.
    Lo que reciba lo desarrolla como el resto de su trabajo: en una hipótesis y un método que propone. Nunca llega al
    junior como texto del proponente sin pasar por él.
  - **El junior** la usa dentro de `investigate`, como describe §2.
  - **Cada hemisferio sabe qué pidió el otro.** Toda solicitud lleva un id (`what_if:<quién>:r<n>.<k>`) que queda en el
    registro de su hemisferio: el senior ve los `what_if` del junior en su registro, y el junior ve una referencia a cada
    solicitud del senior (su id, su modo y su `situation`) en su canal, como hecho del registro. Ver las propuestas del
    senior no bastaba: no dice qué preguntó él. La respuesta no tiene por qué viajar: con la referencia basta para no
    pedir dos veces lo mismo sin saberlo, y quien la quiera la abre por su id.
  - **El coste se cuenta en la parte que lo gasta:** el del junior en sus tokens y el del senior en los de su registro
    de agente.
  - **Disponible siempre, para los dos.** En el investigador asistido, `what_if` está siempre a mano para ambos
    hemisferios. Se apaga sólo con un flag (`--no-what-if`), y entonces para los dos a la vez: es la condición sin ella de
    las comparaciones. No hay variantes en las que la use sólo una mitad. El investigador puro (unknown-world) sigue sin
    ella.
- **Buena parte de las señales de código de la política ya existen:** `stuckSignals` (`orchestra/reader.ts`) calcula
  `only_looking`, `regressions`, `checks_since_best` y `rounds_without_acceptance`. La política las usa como
  observaciones, y añade las que le son propias: pasos desde la última solicitud de `what_if` (de cualquiera de los dos
  hemisferios), separación desde el último disparo de la política, avisos ignorados y presupuesto que queda para
  desarrollar una dirección. Jev añade sólo los juicios semánticos (§3.1).
- **La vista del recorrido existe, pero no basta tal como está.** `orchestra/view.ts` es la capa que separa lo que vio
  el investigador de lo exclusivo del operador, con una lista blanca campo a campo, y la política debe partir de ella.
  Hay que **ampliarla**, porque hoy:
  - `researcherEvents` conserva las peticiones de investigación, pero no sus resultados;
  - no incluye las pruebas propias registradas, sus resultados ni las que están pendientes;
  - `runDigest` resume y recorta.

  Sin los resultados, una política vería repetición de acciones sin saber si esas acciones están aclarando el problema.
  Se amplía con lo que el investigador vio (los resultados de sus pasos tal como se le dieron, sus pruebas y su estado,
  sus `what_if` y lo que recibió) y nunca con lo del operador. El senior se beneficia de la misma ampliación.

### 8.4 Lo que la política es, según los principios

- **El modo automático es ayuda del lado del operador,** como el senior: no es el mundo ni una respuesta del entorno
  («sin investigación precocinada»). Se registra como tal, y las trazas de K4 lo describen.
- **Qué consume cada cosa:**
  - **Evaluar la política** consume presupuesto de inferencia (sus llamadas a Jev, en el coste de K1), nunca ayuda. Una
    evaluación que acaba en `continue` o `abstain` no gasta `help_left`, así que no puede agotar la ayuda del senior.
  - **Entregar una intervención** consume una unidad de `help_left`. Una intervención es un aviso en modo recomendación,
    o un cierre automático con su dirección.
  - **Un cierre y la dirección que lo acompaña son una sola intervención,** con una identidad común (`intervention:<n>`)
    en los dos eventos, para no contarlos dos veces.
  - **Un `what_if` que pide el propio investigador** no es ayuda: consume su paso y su límite de `what_if` (§4).
- **Su primera versión es una heurística nuestra,** y por eso es una condición experimental, no un método del
  investigador. Que el investigador la revise a partir de sus propios runs (§3.2) sí respeta el aprendizaje de fuentes
  propias.
- **Sin Jev (`--flat`), los juicios semánticos no se pueden hacer,** y la política se **abstiene** (§3.1), no continúa.
  Los tests con `--flat` deben comprobarlo.

### 8.5 Lo que el plan debe cubrir además

- **Cerrar una ronda en el mundo de artefactos.** Ahí una propuesta puede traer una versión del artefacto (`artifact`,
  `validate_artifact`) y el run sigue tras aceptar (`goes_on`). El cierre debe tratar las dos cosas igual que con el
  modelo.
- **Lo que se ata a una ronda:** mensajes programados (`messages` por ronda), seguimientos del senior dentro de la ronda
  y reflexiones de cierre de presupuesto. Un cierre voluntario es una ronda más para todos ellos.
- **«Llamada de resultado desconocido» (plan §6).** El registro de repetición sólo guarda respuestas. Para saber que una
  llamada se pidió y no volvió, hay que registrar antes un evento de intención (`what_if_requested`), y al reanudar
  decir «incierta». No se puede afirmar más.
- **El diseño de §6 ya se expresa con K3:**
  - `template`/`vary` con las mismas semillas y `compare_conditions` declaradas con su margen;
  - el presupuesto, controlado por los límites registrados;
  - el control «revisa tu enfoque», como mensaje programado (`messages`) del mismo coste;
  - el coste, sumado por K1: las llamadas de `what_if` son tokens del junior, y las de la política, llamadas al Judge.

### 8.6 Orden propuesto

El plan implementa 1 → 2 → 3 → 4 → 5 y pilota al final. **Propongo adelantar un piloto como diagnóstico, no como
condición para seguir:**

1. **Entrega 1, el cierre explícito de ronda.** Vale por sí misma: hoy ya hay un fallo, porque las pruebas pendientes se
   posponen cuando no hay propuesta.
2. **Entrega 2, `what_if` manual, con su registro y coste.** La parte de registro del plan §6 se adelanta aquí.
3. **Piloto K3 con modelos reales:** sin `what_if` frente a con `what_if`, y con el control de «revisa tu enfoque», en
   dos mundos y con las mismas semillas. La condición sin `what_if` es el flag `--no-what-if`, que la quita a los dos
   hemisferios.
   El piloto distingue tres casos: **no se usó**, **se usó a destiempo** (en momentos donde no había nada que
   reorganizar), y **se usó a tiempo pero las direcciones no aportaron**. Cada uno se lee en el registro con sus pasos.
4. **Entregas 3–5 (la política), en cualquier caso, con lo que el piloto enseñe.** Un resultado manual negativo no
   descarta la política: puede deberse justamente a lo que ella quiere aprender, cuándo pedir. Si el piloto dice «no se
   usó» o «a destiempo», la política es la respuesta natural. Sólo «a tiempo y sin aporte» apunta al proponente (su
   instrucción, su contexto), y eso se revisa en la Entrega 2 antes de seguir.

`SPEC-GENERACION-HIPOTESIS.md` queda como documento de investigación de referencia, como el propio spec dice. Nada de esta
entrega depende de él.
