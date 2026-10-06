# SPEC · Pruebas diseñadas por el investigador: predicciones prerregistradas y severas

Estado: propuesta (06/10/2026), revisada con una revisión externa el mismo día (§12). Nada implementado.

## 1. De dónde sale

En `navigation-goals` (`c302nav`, condición N2), dos runs aceptaron un modelo que predice muy bien las dos señales,
también en la familia de estímulos no vista y en la confirmación a ciegas. Aun así, recuperan muy pocos *insights*
(0,11 el junior y 0,06 el senior, calificados por Sol con el calificador endurecido).

El modelo aceptado es una **sombra** del mecanismo: un suceso por umbral con una respuesta de forma fija, en vez de un
estado de dos valores que conmuta. Las dos descripciones predicen casi lo mismo en las familias de validación, así que
el protocolo acepta la sombra y el run termina.

Lo que diferencia esto de la investigación real:
- **El investigador ya diseña experimentos que discriminan.** En el run `c302nav-n2-task12-4`, el senior pidió pulsos
  emparejados, un pulso sostenido y comparaciones entre lados.
- **Lo que no diseña es la prueba que su modelo debe superar.** Esa la fija el operador. Un investigador real decide
  qué observaciones refutarían su hipótesis y las registra antes de mirar.

**Idea del autor:** un investigador plantea una hipótesis y crea pruebas de laboratorio en las que deben sostenerse las
observaciones y los sucesos que la apoyan.

**Qué no promete.** Superar pruebas propias demuestra que el modelo **discrimina entre explicaciones concretas**, no que
haya recuperado el mecanismo. Es un paso más del método hecho verificable, no una garantía de verdad.

## 2. Principios

- **P1. El entorno sigue diciendo sólo si la regla se sostiene.** Una prueba propia se responde con el mismo tipo de
  veredicto que un check: hechos por punto y si el modelo se sostiene. Nunca con un análisis.
- **P2. Se registra antes de mirar, con el modelo congelado.** Se registran el protocolo, el modelo y el rival, cada
  modelo por su **huella**: código de las observaciones, reglas, pesos y salida. Lo registrado no cambia después. Una
  prueba sólo es **predicción** del modelo con el que se registró.
- **P3. Sólo cuenta una prueba severa, y frente a un rival que también explica lo ya visto.** El rival debe ser una
  explicación genuina de la evidencia compartida (§5). La prueba cuenta como superada sólo si el modelo se sostiene
  **y** el rival no.
- **P4. Experimento nuevo o réplica, dicho por el laboratorio.** La identidad de un experimento la define el
  laboratorio (§4.2), no la forma de la petición. Una prueba con un experimento nuevo y una **réplica** (el mismo
  experimento con otra semilla) aportan evidencias distintas y se registran como tales.
- **P5. Genérico.** Funciona en cualquier laboratorio que ofrezca `act`: el protocolo es un `act` del mundo, leído con
  su propio `act.parse`. Lo que cada mundo debe declarar está en §4. Nada propio de un mundo en el arnés.
- **P6. Las pruebas fallidas no desaparecen.** Toda prueba válida que el modelo no supera queda visible como
  **contraejemplo abierto** hasta que se resuelva (§6.2). No se pueden acumular éxitos tapando fallos.
- **P7. Lo decide el operador.** Si las pruebas propias cuentan para aceptar, y cuántas, es una opción del operador,
  como el umbral de R². El investigador puro sigue congelado.

## 3. La petición

Una petición de investigación nueva, para el investigador asistido:

```json
{"register_test": {
  "protocol": { ...un act del mundo... },
  "model": <ronda> | <borrador>,
  "rival": <ronda> | <borrador> | "rival:<nombre>",
  "claim": "qué predice el modelo y por qué el rival no",
  "kind": "new" | "replicate",
  "place": "<laboratorio>"
}}
```

- **`protocol`:** un `act` del mundo, comprobado con `act.parse`. Si no es válido, el error de forma se explica como en
  un `act`.
- **`model`:** el modelo que se pone a prueba. Se congela por su huella al registrarse.
- **`rival`:** otro modelo del investigador (también congelado), o un **rival público** del laboratorio
  (`rival:<nombre>`, §4.3). Nunca una línea base del operador (`lab.baselines` es sólo del operador).
- **`claim`:** en palabras, qué distingue. Queda para la auditoría y para el senior; el entorno no lo juzga.
- **`kind`:** `new` exige un experimento cuya identidad (§4.2) no haya visto el investigador; `replicate` exige uno que
  sí haya visto, y se ejecuta con otra semilla.
- **Respuesta:** `{"test": "t<n>", "registered": true}`, o el motivo por el que no se registra (forma, identidad,
  rival). Cuesta un `act` del presupuesto de la ronda.

## 4. Lo que cada laboratorio declara

### 4.1 El veredicto en casos degenerados

El objetivo de un laboratorio se pensó para checks sobre episodios de su familia. Una prueba propia puede ser un
protocolo arbitrario, así que el objetivo debe definir su veredicto en tres casos. Hoy, en `c302nav`, el primero es un
fallo: la R² devuelve `null` cuando la señal no varía, y `holds` lo trata como no sostenerse.
- **Señal constante:** el caso de una intervención que la anula. Se juzga por un error absoluto con una tolerancia que
  el laboratorio declara (en `c302nav`, una fracción de la dispersión típica de la familia), no por R².
- **Episodio sin puntos:** la prueba no es válida y no cuenta para nada; se dice así.
- **Respuesta inválida o excepción:**
  - **del modelo:** el modelo no se sostiene;
  - **del rival:** la prueba no es severa. Un rival que no responde no queda refutado por los datos.

### 4.2 La identidad del experimento

`act.identity(act)` devuelve la identidad canónica del **experimento físico**: estímulos, intervenciones y duración,
normalizados. Queda fuera la configuración de **observación** (qué células se registran). Dos peticiones con la misma
identidad son el mismo experimento aunque su JSON difiera: orden, valores por defecto explícitos, células registradas.
- `lab.episodeIdentity(episode)` da la de los episodios del entorno (exploración, check, validación), para comparar con
  los `act`.
- Un laboratorio sin estas dos funciones no admite `kind: "new"`; sólo réplicas de sus propios `act`.

### 4.3 Rivales públicos

`lab.rivals`: modelos que el investigador **puede ver y nombrar**, separados de las líneas base del operador. Por
ejemplo, en `c302nav`: «la corriente filtrada» o «la corriente instantánea». Son opcionales. Con ellos, una prueba puede
enfrentar el modelo a una explicación simple conocida.

### 4.4 Ver las intervenciones

Una prueba con **intervención** sólo discrimina mecanismos si el modelo ve la intervención. En `c302nav`, el percepto
`p = { step, t, inputs }` no la muestra, así que hace falta `p.changes`, en las palabras de la interfaz. Es un cambio del
laboratorio. Si el primer experimento va a probar intervenciones sobre conexiones, se adelanta (T1).

## 5. El rival debe explicar la evidencia compartida

Derrotar a un rival hecho a propósito para perder no prueba nada. Un rival cuenta si, **en el momento del registro**,
explica la evidencia que ya comparten los dos modelos comparablemente bien:
- **La evidencia compartida** son los puntos de los checks que el investigador ya ha visto en sus laboratorios.
- **La regla:** el rival se sostiene en ella, o su resultado en el objetivo no es peor que el del modelo puesto a
  prueba más allá de un margen que fija el operador.
- **Si no la cumple,** el registro se rechaza con ese motivo.

Es una comprobación mecánica con el objetivo del laboratorio, no un juicio. Jev puede **auditar** la pertinencia del
rival (§9), pero eso sólo informa: no se convierte en un criterio de verdad.

## 6. La ejecución, el veredicto y los contraejemplos

### 6.1 Ejecución

Al cerrar la ronda, después de la propuesta, el entorno:
1. **Ejecuta el protocolo** como un episodio nuevo (`test<n>`), con una semilla del entorno.
2. **Aplica el objetivo** (con los casos degenerados de §4.1) al modelo y al rival congelados, sobre los mismos puntos
   que un check.
3. **Responde en la ronda siguiente:** los veredictos por punto del modelo, si el modelo se sostiene, si el rival se
   sostiene y `severe`.
4. **El episodio pasa a ser suyo,** para estudiarlo.

Eventos: `test_registered` (`t`, ronda, protocolo, identidad, `kind`, huellas del modelo y del rival, `claim`) y
`test_result` (`t`, veredictos, `model_holds`, `rival_holds`, `severe`, `valid`, coste).

### 6.2 Contraejemplos

Una prueba válida en la que el modelo registrado **no** se sostiene queda como **contraejemplo abierto** de ese modelo,
visible en el cuaderno del investigador (como los checks) y en el finding. Se cierra cuando:
- **un modelo posterior se sostiene en su episodio,** lo que es una resolución por regresión, no una predicción nueva
  (§7);
- **o el investigador lo da por explicado** con una creencia que lo cite y una prueba nueva que la ponga a prueba.

## 7. Para qué cuentan: prerregistro frente a regresión

Una prueba registrada con el modelo A, fallida y vista, no puede contar como predicción de un modelo B ajustado
después. Por eso hay dos cuentas separadas:
- **`passed_preregistered`:** pruebas severas superadas por **el mismo modelo, con la misma huella**, con el que se
  registraron. Es lo único que cuenta como predicción.
- **`passed_regression`:** pruebas registradas con modelos anteriores que el modelo final también supera, reutilizando
  sus episodios sin simular. Sirve para comprobar que no retrocede, no como predicción.

**`--own-tests N`** (opción del operador):
- **Para aceptar un modelo hace falta:**
  - **N pruebas severas `passed_preregistered` con su huella;**
  - superar en regresión todas las pruebas válidas anteriores, o que sus contraejemplos estén cerrados (§6.2);
  - ningún contraejemplo abierto del propio modelo.
- **Cuándo se comprueba:** antes de gastar la confirmación ciega. Si no se cumple, la validación no pide la
  confirmación.

Sin `--own-tests`, las pruebas sólo informan: la auditoría y el finding las cuentan, y la aceptación no cambia.

## 8. El senior diseña pruebas contra el modelo del junior

El senior sigue sin actuar sobre el mundo. Puede **ordenar** una prueba (SPEC-ORQUESTADOR §3.3.3): «registra esta
prueba, con este protocolo, tu modelo y este rival». El junior la registra tal cual, salvo que discrepe y lo diga
(`to_senior`). La prueba queda atribuida (`by: agent:senior`).

Es el papel del revisor que pide el experimento que más puede refutar. El senior conoce el modelo del junior y puede
buscar dónde falla la sombra.

## 9. Medidas

- **Para el operador**, por investigador:
  - pruebas registradas, válidas y severas;
  - `passed_preregistered` frente a `passed_regression`;
  - contraejemplos encontrados y resueltos, y cuánto tardan en cerrarse;
  - pruebas nuevas frente a réplicas;
  - quién las diseñó (junior o senior).
- **En la auditoría del método,** dos preguntas sobre cada prueba registrada, que juzga Jev y que sólo informan:
  - ¿el rival es una explicación genuina o un muñeco de paja?
  - ¿el `claim` coincide con lo que el protocolo puede distinguir?

## 10. Evaluación

Comparar con un run histórico mezcla cambios de código, presupuesto y duración. Para atribuir una mejora al método:
- **Runs emparejados con la misma versión del código:** con y sin `--own-tests`, varias seeds y el mismo presupuesto.
- **Qué se mide:**
  - aceptación;
  - *insights*, con el calificador endurecido y un modelo distinto del que investiga;
  - contraejemplos encontrados y resueltos;
  - coste.

El primer run, el de `c302nav` N2 con `--own-tests 2`, es un **piloto**: sirve para ver que el mecanismo funciona, no
para concluir.

## 11. Coste y plan

**Coste por prueba:**
- una simulación (en `c302nav`, entre 1 y 2 minutos);
- evaluar dos modelos en sus puntos (llamadas a Jev sólo si tienen reglas);
- comprobar el rival en la evidencia compartida, sin simular.

**Plan.** Empieza después del contrato de los instrumentos (SPEC-ANOMALIAS-INSTRUMENTO A1):
- **T1.** Lo que declara el laboratorio:
  - el veredicto en casos degenerados (§4.1) en `c302nav` y en los demás objetivos;
  - `act.identity` y `episodeIdentity` (§4.2);
  - `lab.rivals` (§4.3);
  - `p.changes` en `c302nav` (§4.4), si el piloto va a usar intervenciones.
- **T2.** `register_test` como herramienta **informativa**: forma, identidad, rival que explica la evidencia (§5),
  huellas, ejecución al cerrar la ronda, veredicto, contraejemplos y eventos.
- **T3.** `--own-tests N` en la aceptación, con `passed_preregistered` y `passed_regression`, y la comprobación antes
  de la confirmación ciega. Sólo cuando T1 y T2 estén cerrados.
- **T4.** La orden del senior para registrar una prueba. Las preguntas de la auditoría. Las medidas en el finding y en
  el informe del lote.

## 12. Revisión externa (06/10/2026): qué cambió

- **Un modelo ajustado después ya no hereda las pruebas del anterior.** Se separan `passed_preregistered` y
  `passed_regression` (§7), y los modelos se congelan por su huella.
- **El rival debe explicar la evidencia compartida** (§5), y las pruebas fallidas quedan como contraejemplos abiertos
  (§6.2, P6).
- **El veredicto en casos degenerados** (§4.1): señal constante, episodio sin puntos, excepción del rival.
- **La identidad canónica del experimento,** separada de la observación, y la distinción entre réplica y protocolo
  nuevo (§4.2).
- **Rivales públicos,** separados de `lab.baselines` (§4.3).
- **El requisito se resuelve antes de la confirmación ciega** (§7).
- **`p.changes` se adelanta** si el piloto prueba intervenciones (§4.4).
- **Evaluación con runs emparejados** en la misma versión y varias seeds (§10). Las pruebas empiezan siendo
  informativas, y el requisito de aceptación llega al final (T3).
