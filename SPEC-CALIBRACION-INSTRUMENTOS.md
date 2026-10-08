# SPEC · Calibración e integridad de instrumentos: cuando la realidad puede ser un bug

Estado: propuesta (06/10/2026), revisada con una revisión externa el mismo día (§10). Nada implementado.

Cubre las tres fases: calibrar el instrumento antes de investigar (§3), detectar sus fallos durante el run (§4–§5) y recuperarse de la contaminación que dejen (§6). Antes se llamaba «Anomalías del instrumento».

## 1. De dónde sale

En el mundo real, la realidad no tiene fallos; los instrumentos sí. En un mundo simulado, el código **es** la realidad,
y un fallo en él es una ley falsa del universo que el investigador aprende con toda su seriedad.

En dos días de `navigation-goals` (`c302nav`) aparecieron tres:
- **El `act` aceptaba campos desconocidos** y los ignoraba. En el run `c302nav-n2-task12-2`, el investigador cortó
  AWCL→AIYL y AWCL→RIAL y cambió `ca_conc_decay_time`. Ninguna de las tres intervenciones se aplicó, y el entorno las
  dio por aceptadas. El senior construyó una hipótesis sobre ellas.
- **El entorno devolvía el `act` con los nombres internos** del servicio (`changes.remove_connections`). El
  investigador los copiaba y caía en el fallo anterior.
- **Una simulación divergida** devolvía un 500 o un JSON inválido y tumbaba el run.

Antes, la lectura de las señales: en N0 hizo falta descubrir que la reorientación de su conjunto de prueba estaba
filtrada dos veces, y que nuestra señal de giro no es la suya.

**Idea del autor:** en nuestros mundos simulados, la realidad puede ser un bug en el código y echar por tierra el
experimento.

## 2. Dos defensas, como en la ciencia real

1. **Calibrar el instrumento por separado** (operador, §3): antes de medir el fenómeno, comprobar que el instrumento
   hace lo que dice.
2. **Desconfiar durante la medida** (investigador, §4, y operador, §5): controles sobre el propio instrumento, y
   anotar aparte una sospecha de artefacto, sin incorporarla al conocimiento del fenómeno hasta resolverla.

## 3. Calibrar el instrumento: el contrato de cada laboratorio

Pruebas que cualquier laboratorio debe pasar antes de que se investigue en él, en la suite de contratos
(`test/labs.test.ts`).

**Cubre también los laboratorios externos** (`tank`, `particles3d`, `c302nav`), que hoy quedan fuera y son
precisamente donde aparecieron los fallos. Para ellos, la suite usa el servicio real con un **trabajador sustituto**
(como `test/c302-service.test.ts`), y cada laboratorio declara `act` de ejemplo.

- **I1. Ida y vuelta del `act`.** Para cada `act` de ejemplo válido, `act.parse(act.asWritten(act.parse(x)))` coincide
  con `act.parse(x)`. Lo que el entorno devuelve es lo que el investigador puede volver a escribir.
- **I2. Un campo desconocido se rechaza.** Cada `act.parse` devuelve un error de forma ante un campo que no conoce.
- **I3a. La petición se traduce bien.** Un `act` con intervención llega al servicio con esa intervención en la forma del
  servicio. Se comprueba con el trabajador sustituto, que registra lo que recibe. Prueba que **se envió**, no que el
  simulador la aplicó.
- **I3b. La intervención se aplica en un caso de calibración conocido.** Cada mundo intervencionista declara al menos
  un caso cuyo efecto se conoce de antemano. En `c302nav`, por ejemplo, cortar la única conexión de una célula
  estimulada hacia otra deja a esta en reposo. Ese caso se ejecuta contra el simulador real, a mano, fuera de la suite
  rápida, y deja su resultado en la spec del mundo.
  - Una intervención que no cambia la salida bajo un estímulo cualquiera **no** es un fallo: puede ser un resultado
    legítimo. Por eso I3 se comprueba sólo en el caso de calibración.
- **I4. Determinismo.** El mismo `act` con la misma semilla da el mismo episodio dos veces. Un mundo con ruido declara
  su ruido.
- **I5. Lo expuesto respeta la interfaz.** Lo que se **muestra al investigador** (percepto, `view`, la respuesta de un
  `act`, el índice de episodios) no contiene valores no finitos ni campos que la interfaz no declara. El episodio puede
  guardar información interna para el operador; no se muestra. Una respuesta imposible del servicio externo es un
  rechazo (422) o un error explicado, nunca un dato.
- **I6. Fidelidad a la fuente,** para un mundo portado de otro: una prueba que compare con la fuente original, como N0
  hizo con su simulador. Se ejecuta a mano y deja su resultado, con la **versión del instrumento**, en la spec del
  mundo.

## 4. Desconfiar durante la medida: el investigador informa de anomalías

### 4.1 El canal

En cualquier respuesta, el investigador asistido (y el senior) puede añadir:

```json
"instrument_report": {
  "what": "lo que el entorno hizo que no cuadra con lo que dice su interfaz",
  "evidence": ["<episodios, puntos, pasos de investigación>"],
  "kind": "accepted_but_not_applied" | "inconsistent_answer" | "impossible_value" | "not_what_the_interface_says" | "other"
}
```

- Se registra como `instrument_report` en el journal, con su autor (junior o senior). La consola lo muestra aparte, con
  aviso al operador.
- **No es una creencia ni evidencia sobre el mundo:** no entra en el cuaderno ni en el modelo. Es una sospecha sobre el
  instrumento.
- No cuesta pasos de investigación.

### 4.2 Qué le dice su prompt

Una sección corta, sólo del investigador asistido. El investigador puro queda congelado:
- el entorno es un instrumento hecho por personas y puede fallar;
- si una respuesta contradice lo que dice la interfaz, o un experimento de control muestra que el instrumento no hace
  lo que dice, se informa con `instrument_report` y no se toma como ley del mundo hasta que el operador responda;
- **controles del instrumento** con las herramientas que ya tiene: repetir el mismo `act` (¿da lo mismo?), comprobar
  que una intervención cambia algo en un caso donde debería, releer lo que el entorno devuelve de su propia petición.

Son estrategias de uso de herramientas sin ejemplos del entorno: entran en lo permitido como guía de método (memoria
`feedback-method-guidance`).

### 4.3 El senior también informa

El senior, al leer el registro, puede detectar lo que el junior no ve. Es lo que pasó en `c302nav-n2-task12-2`, donde
el senior vio que el parámetro iba bajo `changes.param_overrides`. Usa el mismo canal, atribuido a él.

## 5. El ciclo de una anomalía

### 5.1 Mientras está pendiente

- **El resultado no se borra ni cambia de signo.** Un fallo sigue siendo un fallo, y un éxito, un éxito. Los episodios y
  pasos citados en el informe quedan marcados como **cuestionados** (`questioned`), con el informe.
- **La investigación sigue.** El investigador puede trabajar en lo que no depende de esa evidencia.
- **La aceptación no puede depender de evidencia cuestionada.** Si la validación, la confirmación ciega o una prueba
  propia (SPEC-PRUEBAS-PROPIAS) que el modelo necesita para aceptarse se apoya en un episodio cuestionado, la
  aceptación espera al veredicto. El run sigue con otras rondas mientras tanto.
- **Si el operador nunca responde,** la marca permanece hasta el final. El finding la muestra, y una aceptación que
  dependiera de ella no se produce: el run termina como no aceptado, por esa razón dicha.

### 5.2 El veredicto del operador

Desde la consola o con `lab anomaly <run> <id> <veredicto> [texto]`:
- **`bug`:** un fallo del instrumento.
  - Los resultados cuestionados pasan a **invalidados**. Queda registrado cuáles, y qué aceptación anterior, si la
    hubo, queda afectada.
  - El arreglo va al código con su prueba en el contrato (§3), y el run sigue según §6.
- **`world`:** no es un fallo, es el mundo, como una simulación que diverge con una corriente extrema.
  - La marca se retira.
  - Se puede responder al investigador con un mensaje del operador: sólo «no es un fallo del instrumento», nunca cómo
    es el mundo.
- **`unclear`:** sigue cuestionado.

Un informe con veredicto `bug` cuenta a favor del método del investigador en la auditoría: detectó un artefacto. Uno
`world` no penaliza. Distinguir instrumento de fenómeno es buena práctica aunque se equivoque.

## 6. Arreglar y seguir: una frontera de versión y de conocimiento

Un fallo confirmado no se arregla dentro del run: se arregla en el código, y el run sigue en una **rama** identificada.
- **La rama** es un run derivado (`--resume`). Lleva:
  - la **versión del instrumento** (el commit del arreglo);
  - la procedencia del corte: el run de origen, el punto de corte y el informe que lo motivó.
- **El punto de corte** es el último anterior al primer resultado invalidado. La reproducción llega hasta ahí; lo
  posterior va en vivo, con el instrumento arreglado.
- **Lo que no se lleva a la rama** cuando depende de datos invalidados:
  - las notas y creencias del cuaderno que los citan;
  - los mensajes del senior que los citan, y su propio cuaderno;
  - las publicaciones de equipo que los citan (SPEC-INVESTIGACION-PARALELA);
  - la experiencia de otros runs que los citen.
- **Qué se puede saber de la contaminación.** Se rastrea por **citas y dependencias registradas**. No se puede saber
  exactamente qué influyó en el LLM, porque lo leyó todo. El finding distingue:
  - **dependencia demostrada:** lo que cita evidencia invalidada;
  - **posible exposición:** lo escrito después de verla, sin citarla.

## 7. Qué no hace

- **No corrige el mundo durante el run** (§6).
- **No le dice al investigador cómo es el mundo.** El operador sólo confirma o descarta que el instrumento falle.
- **No sustituye las pruebas del contrato.** Es la red de seguridad para lo que el contrato no previó.

## 8. Medidas

- **Informes por run:** cuántos y de quién, y su veredicto (`bug`, `world`, `unclear`).
- **Tiempo hasta el informe:** cuántas rondas pasan entre el primer episodio afectado y el informe.
- **Contaminación:** qué parte de las creencias del investigador depende de evidencia invalidada (demostrada) o pudo
  estar expuesta a ella (posible).
- **Aceptaciones afectadas:** cuántas y cuáles.

## 9. Plan

- **A1.** El contrato del laboratorio (§3: I1, I2, I3a, I4 e I5) para todos los mundos de `LABS`, incluidos los
  externos con trabajador sustituto, y los `act` de ejemplo que cada laboratorio declare. Arreglar lo que salga, por
  ejemplo los `act` de `tank`, `orbit` y `cells`, que hoy ignoran campos desconocidos.
- **A2.** I3b e I6 como procedimiento manual de cada mundo portado o intervencionista, con su resultado y versión en la
  spec del mundo: para `c302nav`, el caso de calibración del corte de una conexión.
- **A3.** El canal `instrument_report` en el cliente del investigador asistido (junto a `to_senior`) y en el senior,
  con la sección de su prompt.
- **A4.** El ciclo (§5): marcas cuestionadas e invalidadas, la aceptación que espera, `lab anomaly` y la consola.
- **A5.** La rama tras un arreglo (§6): versión del instrumento, punto de corte y exclusión de lo dependiente. La
  contaminación demostrada y la posible en el finding.

**A1, implementado (06/10/2026):**
- Cada laboratorio con `act` declara `act.examples(spec)` y rechaza los campos que no conoce con `unknownFields`
  (`learn/lab.ts`), también dentro de sus listas: los estímulos de `c302nav` y los lanzamientos de `particles3d`.
- El `act` de `grid` (`{act, from, to}`) hace lo mismo.
- `test/labs.test.ts` comprueba I1, I2, I4 e I5 en `cells`, `orbit`, `tank`, `particles3d` y `c302nav`. Los externos
  usan un sustituto:
  - el servicio de c302 con un trabajador que anota lo que recibe;
  - el servicio de `tank`, en proceso;
  - un Blender que deja quietas las partículas.
- I3a: una intervención con nombres neutros llega al trabajador con los nombres reales y en la forma del servicio.
- **Ruido declarado (I4):** `act.varies(act)` dice qué puede cambiar entre dos ejecuciones del mismo `act`, como lo
  dice su interfaz. En `tank`, el nivel inicial cuando el `act` no da `start`.
- **Pendiente:** la parte de I5 sobre campos no declarados por la interfaz. Hoy sólo se comprueba que todo número
  mostrado sea finito.

**A2 en `c302nav`, primer caso (07/10/2026).** La batería de L0 del lazo cerrado (SPEC-C302-LAZO-CERRADO) encontró un
fallo del tipo «aceptado pero no aplicado» que el contrato rápido (A1) no podía ver, porque el sustituto no simula:
- **El fallo:** `parameters` admitía cualquier nombre. c302 añade como parámetro nuevo uno que el conjunto no tiene, y
  nadie lo lee. El ejemplo de `act` de `c302nav` usaba uno así (`neuron_to_neuron_chem_exc_syn_gbase`, que no existe en
  C1).
- **El arreglo:** el trabajador rechaza (400) los nombres que el conjunto no tiene y da la lista de los que tiene.
- **El caso de calibración I3b,** contra el simulador real: con `neuron_to_neuron_exc_syn_conductance` de 0,09 a
  0,18 nS, el pico de AIYL pasa de 9,67·10⁻⁷ a 1,015·10⁻⁶.
- **La contaminación:** ningún run anterior usó un nombre inválido. Sólo uno usó parámetros, y válidos.

Es la defensa de §2.1 funcionando: calibrar el instrumento por separado encontró lo que la medida no veía.

**A3, implementado (06/10/2026):**
- `learn/instrument.ts`: `INSTRUMENT_SECTION` y la lectura de `instrument_report`, uno o una lista. Un tipo desconocido
  pasa a `other`; uno sin `what` se descarta.
- **El junior:** su prompt (`assistedSystem`) termina con la sección. `operatorClient` registra cada informe como
  `instrument_report` con `question`, `round`, `id` (`ir1`, `ir2`…) y `by: "junior"`.
- **El senior:** `SENIOR_ROLE` le dice que puede informar en cualquier respuesta. Sus informes van en su decisión
  (`instrument_reports`), en el registro del agente.
- **La consola** pasa `instrument_report` también al perfil investigador. El aviso al operador es parte de A4.
- Un run reanudado de antes de este cambio diverge en su primera pregunta, porque el prompt cambió, y sigue en vivo.

**A4, implementado (06/10/2026):**
- **Qué se cuestiona** (`learn/anomalies.ts`): los lugares de los episodios que cita un informe, o los lugares que
  nombra. Un informe que no cita ninguno cuestiona el instrumento entero, es decir, todos los lugares. La granularidad
  es el lugar: si el instrumento falla en un lugar, todo lo que ocurre ahí es sospechoso.
- **La aceptación que espera:**
  - La opción `hold` del protocolo comprueba los lugares por los que pasa la aceptación: laboratorios, familia y
    lugares ciegos. Si alguno está cuestionado, o tiene un `bug` sin resolver, no acepta: la ronda queda en
    `protocol.waiting`, el check registra `acceptance_held_for` y el investigador lee `acceptance_waits`.
  - Al empezar cada ronda, `settleWaiting` resuelve la espera. Si todos sus informes son `world`, se acepta con la ronda
    original (`accepted` con `released_by`). Con un `bug`, la aceptación se anula (`acceptance_void`).
  - Con un `bug`, nada que pase por su lugar se vuelve a aceptar en ese run: el arreglo es una rama (§6).
  - Si nadie responde, el run termina sin aceptar, con `instrument.acceptance_held` en el `end` y «NOT ACCEPTED» en el
    finding.
- **El veredicto** se escribe junto al journal (`<run>.anomalies.jsonl`), con `lab anomaly <run> <id>
  bug|world|unclear [nota]` o con los botones de la consola. `lab anomaly <run>` lista los informes y su estado.
  - El run en marcha recoge el veredicto con su latido y antes de cada pregunta, y lo registra (`anomaly_verdict`, con
    `invalidated` si es `bug`).
  - Al investigador asistido sólo se le dice si el instrumento falló; nunca la nota del operador.
  - Un run reanudado aplica los veredictos de su historia desde la ronda en que se tomaron, y los escritos después de
    que terminara, desde el principio.
- **Los informes del senior** llegan al run por su buzón (`kind: "instrument_report"`), desde cualquier agente y sea
  cual sea la política, y se registran con id `ir-<agente>-<n>`.
- **La consola** muestra en cada run sus informes pendientes o `unclear`, con un aviso y botones de veredicto.
- **Pendiente:**
  - `grid` registra los informes, pero su bucle no retiene la aceptación;
  - contar el veredicto `bug` a favor del método en la auditoría (§5.2).

**El orden:** A1 primero, porque es requisito de las pruebas propias. Después, A3 y A4, que hacen informativo el canal.
A5, cuando aparezca el primer `bug` confirmado que lo necesite.

## 10. Revisión externa (06/10/2026): qué cambió

- **I3 se separa** en traducción de la petición (I3a, con sustituto) y aplicación efectiva en un caso de calibración
  conocido (I3b, real). Una intervención sin efecto puede ser legítima.
- **I5 se refiere a lo expuesto al investigador,** no al episodio interno.
- **La suite cubre los laboratorios externos** con trabajador sustituto.
- **Se define el ciclo de una anomalía pendiente** (§5.1): el resultado se conserva marcado, la investigación sigue, la
  aceptación no puede depender de evidencia pendiente y la marca persiste si nadie responde. Con un `bug` confirmado,
  queda registrado qué se invalida y qué aceptación queda afectada.
- **Arreglar y seguir pasa a ser una rama** (§6), con versión del instrumento, procedencia del corte y exclusión de
  memorias, mensajes del senior y publicaciones dependientes. La contaminación se separa en demostrada y posible.

## 11. Revisión externa de `c302closed-n2-4` (08/10/2026): la huella del modelo y el calificador

Dos instrumentos del arnés, no del laboratorio, dieron una lectura engañosa en el run `c302closed-n2-4` (señales, s1).

### 11.1 Un modelo idéntico se trató como nuevo

**Qué pasó.** Los modelos de las rondas 15 y 16 son el mismo salvo un espacio (`0.0692421/2.5, -0.274346` frente a
`0.0692421/2.5,-0.274346`). La huella (`lawFingerprint`, un hash del texto del modelo) distingue espacios, así que dio
dos huellas (`immjhk` y `1vpw1ww`). El protocolo no reutilizó la comprobación de la ronda 15 y volvió a comprobar el
modelo con episodios nuevos:

| ronda | huella | lab1 | place2 |
|---|---|---|---|
| 15 | `immjhk` | se sostiene (0,674 / 0,677) | se sostiene (0,606 / 0,56) |
| 16 | `1vpw1ww` | se sostiene (0,786 / 0,728) | **falla** (0,399 / 0,443); en los puntos de la 15, sigue sosteniéndose |

La lectura del run como «el refinamiento de la 16 perdió place2» era falsa: no hubo refinamiento. Lo que se vio es
**fragilidad ante episodios nuevos**.

**Corrección (al implementarlo):** en la ronda 16 el junior volvió a proponer el modelo de la 15 **pidiendo validarlo**,
como el protocolo prevé: un modelo que se sostuvo en todos sus laboratorios en la última comprobación se valida sobre
esa comprobación, sin otra que pueda fallar por azar. Con la huella correcta, la ronda 16 habría reutilizado la
comprobación de la 15 y habría pasado a validar en los lugares de la familia y, si se sostenía, a la confirmación a
ciegas, todos con episodios nuevos. El fallo de la huella no hizo de réplica afortunada: **le negó al junior una
validación a la que tenía derecho**, y en su lugar repitió la comprobación de laboratorio. La fragilidad la habría puesto
a prueba igualmente la validación.

**El cambio:**
- **La huella se calcula sobre el código normalizado:** sin espacios ni saltos de línea fuera de las cadenas de texto, y
  con el resto del modelo serializado de forma estable, como ya se hace. Las huellas guardadas en diarios anteriores no
  se recalculan: las repeticiones de runs antiguos deben dar lo mismo. La normalización lleva versión (`fingerprint:
  2`) y el diario dice con cuál se calculó cada una.
- **Un modelo idéntico a uno anterior se reconoce y se dice:** «es el modelo de la ronda 15». Lo ven el junior, en su
  check, y el senior, en su resumen.
- **Su nueva comprobación cuenta como réplica, no como modelo nuevo.** Los veredictos se acumulan por huella y por
  laboratorio (en el ejemplo, place2: 1 sostenido, 1 fallido), y el check muestra ese historial. Es lo que el entorno
  sabe decir, si la regla se sostiene y cuántas veces, sin métrica añadida.
- **Qué cuenta para aceptar:** como hasta ahora, la confirmación a ciegas sobre episodios nuevos. Un fallo en una réplica
  no se borra porque otra se sostuviera.
- **Pruebas:** dos modelos que sólo difieren en espacios dan la misma huella; uno que difiere en una cadena de texto, no;
  el diario de un run antiguo se repite igual.

### 11.2 Una forma de modelo juzgada como falsa creencia

**Qué pasó.** La calificación del run (0,06) anotó como falsa creencia: *«el modelo final calcula salidas continuas a
partir de núcleos de historia con compuertas, en vez de regímenes de acción discretos; esto contradice la afirmación
de I2»*. No es una afirmación del investigador, sino la forma de su modelo. Un modelo continuo con compuertas puede
implementar regímenes discretos, y el modelo no dice que no los haya. El prompt del calificador ya exige que una falsa
creencia sea una afirmación que un enunciado verdadero contradice (`operator.ts`), pero no le impide tomar la forma del
modelo por una afirmación.

**El cambio:**
- **Una falsa creencia es una afirmación explícita del investigador:** en el hallazgo, en una creencia del cuaderno o en
  la definición de una observación. Va **citada textualmente**, con su lugar, y con el enunciado verdadero que la
  contradice.
- **La forma del modelo no es una creencia:** cómo calcula (continuo, discreto, con núcleos o con reglas) sólo cuenta si
  el investigador afirma que el mecanismo es así.
- **Una falsa creencia sin cita se descarta** al leer la respuesta del calificador y queda en el registro como
  descartada, para revisar el calificador.
- La versión del calificador sube. Los runs ya calificados conservan su nota y su versión; recalificar es explícito.
- **El efecto en la nota es pequeño** (0,06 seguiría siendo bajo), pero una falsa creencia mal juzgada desinforma al
  operador y a la auditoría.

### 11.3 Implementado (08/10/2026)

- **La huella, versión 2** (`lawFingerprint(law, version)`, `normalizeCode`, `ownFingerprint` en `law-session.ts`):
  - fuera de las cadenas y plantillas de texto, los espacios desaparecen, salvo uno entre dos caracteres de palabra
    (`return x`) o entre dos signos iguales que se unirían (`a + +b`); las definiciones y las instrucciones de las reglas
    sólo colapsan espacios;
  - el diario guarda la versión (`config.fingerprint`). Un run nuevo usa la 2; uno reanudado o continuado, la de su
    diario (sin ella, la 1). Comprobado sobre `c302closed-n2-4`: la versión 1 reproduce las 16 huellas del diario, y con la
    2 las rondas 15 y 16 dan la misma (`vj8hl4`).
- **Réplicas** (`replications` en el protocolo, activas con la versión 2): un modelo ya propuesto lleva en su check
  `same_model_as_round` y `this_model_so_far` (por lugar, cuántas veces se sostuvo y cuántas no). Un check reutilizado no
  cuenta dos veces. `restart()` (un nuevo estadio, un cambio de foco) los olvida.
- **El senior** ve `same_model_as_round` en su resumen siempre: lo calcula con la versión 2 sobre el diario, también en
  runs de la versión 1. En la continuación de `c302closed-n2-4` verá que la ronda 16 es el modelo de la 15.
- **El calificador, versión 2** (`GRADER_VERSION`, `FALSE_BELIEF_RULE`, `quotedFalseBeliefs` en `operator.ts`): la regla se
  añade al prompt de cada calificador; las falsas creencias sin cita textual que aparezca en lo que el investigador
  escribió (sin distinguir mayúsculas, comillas ni saltos de línea) van a `false_beliefs_discarded`. El evento y el
  finding llevan `grader_version`.
  - En el run, sólo en las rondas que este código revisa (`review_from`, SPEC-INVESTIGADOR-ASISTIDO §14.6): el final de una
    historia que se repite se califica como se calificó.
  - `lab grade` (recalificar) usa siempre la versión 2.
  - El calificador del bucle propio de la cuadrícula sigue en la versión 1; recalificar lo pasa a la 2.
- **Pruebas:** `test/fingerprint.test.ts` (normalización, versiones, falsas creencias citadas) y `test/protocol.test.ts`
  (réplicas).
