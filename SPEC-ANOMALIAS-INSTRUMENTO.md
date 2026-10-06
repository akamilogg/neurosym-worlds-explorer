# SPEC · Anomalías del instrumento: cuando la realidad puede ser un bug

Estado: propuesta (06/10/2026), revisada con una revisión externa el mismo día (§10). Nada implementado.

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
