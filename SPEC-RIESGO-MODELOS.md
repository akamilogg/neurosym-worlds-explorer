# SPEC · Gestión del riesgo de modelos: el arnés como evidencia de validación

Estado: propuesta (07/10/2026), revisada con una auditoría externa el mismo día (§13). Nada implementado. Va de la mano
de SPEC-CONTROL-ARNES, que describe el arnés como un proceso controlado. Esta spec decide qué evidencia produce cada
modelo aceptado, cómo se versiona y quién la firma.

## 1. De dónde sale

### 1.1 La cadena de razonamiento

La spec es el último eslabón de una conversación que empezó lejos del código (07/10/2026):

1. **La curva S de lo digital.** La era digital son tres curvas anidadas: TIC (madura), IA sobre dominios ya digitales
   (en plena subida) y digitalización del mundo físico y biológico (antes de su inflexión). Su retrato está en el
   artefacto «La curva S de lo digital».
2. **Digitalizar tiene niveles:** registrado (N1), predecible (N2), mecanístico (N3, acierta bajo intervención) y
   diseñable (N4, lazo cerrado). La IA actual lleva dominios a N2 con facilidad. El valor económico está en N3 y N4.
3. **El cuello de botella pasa de generar a verificar.** En nuestros runs, el par junior y senior razona por céntimos;
   lo caro es el experimento y saber si el resultado es correcto.
4. **De ahí, una pregunta de carrera.** ¿Qué hace un ingeniero de software cuando la IA programa mejor que él? La
   respuesta salió del propio proyecto. El autor no escribió el código, pero tomó las decisiones que le dieron valor:
   - vio que el modelo aceptado era una sombra;
   - formuló que en un mundo simulado la realidad puede ser un bug;
   - diseñó la relación entre junior y senior;
   - juzgó los runs por el método.

   El rol es diseñar el sistema dentro del cual trabajan las IAs, decidir qué cuenta como éxito y detectar cuándo el
   éxito es falso.
5. **La banca ya tiene una disciplina para esto.** El autor viene de banca y comercio online. La gestión del riesgo de
   modelos bancaria tiene piezas muy parecidas a las del arnés:

   | banca | arnés |
   |---|---|
   | modelo retador | rival que explica la evidencia compartida |
   | backtesting | checks |
   | validación fuera de muestra | familia de validación y confirmación a ciegas |
   | registro de auditoría | diario y reproducción |
   | calidad del dato | contrato del instrumento |

   La industria, hacia donde quiere ir el autor, está metiendo IA en planta sin una cultura de validación tan formal.
6. **La pregunta del autor:** ¿puede el arnés implementar SR 11-7?

### 1.2 La respuesta, corregida por la auditoría

- **SR 11-7 ya no está vigente.** La sustituyó SR 26-2, «*Revised Guidance on Model Risk Management*», del 17/04/2026,
  que reemplaza también a SR 21-8.
- **La guía nueva excluye expresamente la IA generativa y agéntica** (nota 3, tras la definición de modelo): «*not
  within the scope of this guidance*».

Por tanto, el LLM investigador **no** es un «modelo de proveedor» cubierto por la guía bancaria, y esta spec no lo
presenta así. Lo que sí puede caer bajo la gestión del riesgo de modelos es el **artefacto cuantitativo** que el
investigador produce, según el uso que se le dé.

Y la respuesta de fondo no cambia. Ninguna guía de este tipo la «implementa» un programa, porque son de gobierno de una
organización: roles, políticas, consejo y auditoría interna. El arnés puede producir la **evidencia técnica** que un
validador o un supervisor leería, trazable y versionada.

### 1.3 Lo que los experimentos añaden a la disciplina

- **La discrepancia entre predicción y mecanismo.** En `c302nav`, el protocolo aceptó un modelo que pasaba el check, la
  familia y la confirmación a ciegas, y recuperaba 0,11 de los hallazgos del mecanismo según la rúbrica y el
  calificador usados. Hay evidencia favorable para usarlo al anticipar las señales en las condiciones evaluadas, y
  evidencia insuficiente para justificar su uso al diseñar intervenciones. La evidencia debe separar esas dos cosas (§6).
- **El instrumento que miente:** tres fallos del simulador se convirtieron en «leyes» para el investigador. La
  verificación del proceso debe cubrir el instrumento (SPEC-CALIBRACION-INSTRUMENTOS).
- **Lo que se aprobó debe poder reconstruirse.** Un lote conservaba una recuperación de 0,25 mientras el finding
  recalificado mostraba 0,11. Una aprobación sobre datos que cambian después no dice qué se aprobó (§7.4).

## 2. Qué no promete

- **No da cumplimiento normativo.** Cumplir una guía o una ley es responsabilidad de una organización. El arnés produce
  evidencia, y la conformidad la declara una persona con autoridad para hacerlo.
- **No sustituye al validador.** El informe es un borrador con hechos verificables. El juicio lo firma una persona.
- **No convierte el LLM en un modelo regulado.** La capa del modelo generador se caracteriza con controles propios
  (§8.2), no por correspondencia con una guía que lo excluye.
- **Cada correspondencia normativa lleva su referencia completa** (§10.1). Lo no contrastado con el texto se marca como
  tal y no se presenta ante terceros.

## 3. Principios

- **R1. Evidencia, no declaración.** Cada afirmación del informe apunta a un hecho del diario, del finding o de la
  auditoría.
- **R2. Tres capas de modelo** (§4): configuración generadora, artefacto aceptado y dependencias de ejecución.
- **R3. Independencia en tres dimensiones**, registradas por separado y nunca reducidas a un booleano (§7).
- **R4. Lo firmado es inmutable.** Una aprobación remite, mediante hashes, a una revisión cerrada de toda su evidencia.
  Recalcular crea una revisión nueva (§7.4).
- **R5. La validación caduca.** Cambiar una dependencia de ejecución, el instrumento o el contexto de uso obliga a
  revalidar (§8.1).
- **R6. Cada resultado con su nombre.** Aceptación predictiva, evidencia discriminante, adecuación al uso y
  recuperación mecanística son dimensiones distintas (§6). Ninguna se llama «correcto».
- **R7. Cada prueba con su nombre.** Reproducir un registro, reejecutar el instrumento, reevaluar con episodios
  sintéticos y monitorizar observaciones reales son evidencias distintas, y el informe las llama así (§6.3, §9).
- **R8. El artefacto y su generador se evalúan por separado.** La robustez de un modelo se mide con ese mismo modelo
  congelado en condiciones distintas. Que investigaciones independientes produzcan modelos buenos habla del proceso que
  los genera, no de ninguno de ellos (§6.5, §6.8).

## 4. Qué es un modelo aquí: tres capas

- **Configuración generadora:** el LLM (proveedor, identificador y parámetros) y la configuración del arnés que produjo
  el modelo: investigador, memoria, senior, apertura, presupuestos y `--own-tests`. Cambiarla no altera un artefacto ya
  aceptado, pero sí lo que produzca a partir de entonces.
- **Artefacto aceptado:** la ley o la fórmula (observaciones, reglas, pesos y salida) con su huella.
- **Dependencias de ejecución:** lo que el artefacto necesita para dar una respuesta.
  - El ejecutor de código y la versión de la percepción del mundo.
  - **El Judge (Jev) con su modelo, cuando la ley tiene reglas.** Sólo un artefacto de salida pura en código, como el
    último predictor de `c302nav`, se ejecuta sin LLM.

  Cambiar una dependencia **sí** puede alterar el comportamiento del artefacto, y obliga a revalidarlo.
- **Contexto de uso** (concepto tomado de ASME V&V 40 y adaptado, §10.3): qué pregunta responde el modelo, en qué rango
  de condiciones y para qué decisión, con los **criterios de adecuación** declarados antes de evaluar.

## 5. El inventario de modelos

Un archivo por proyecto, `runs/models/inventory.json` (`model_inventory@1`). Una entrada por modelo aceptado que el
operador decide inventariar (`lab model register <run> --use "<contexto de uso>"`):

- **Identidad:** id, huella del artefacto, run y commit de origen, versión del instrumento, mundo y lugares.
- **Las tres capas** (§4), con las versiones de cada dependencia de ejecución.
- **Propietario:** la persona responsable, que no es un agente.
- **Contexto de uso y criterios de adecuación.**
- **Criticidad** según el perfil (§10).
- **Estado:** `en validación`, `aprobado`, `aprobado con limitaciones`, `rechazado`, `revalidar` o `retirado`.
- **Historial de estados:** cada cambio con su fecha, quién lo hizo (persona, o el proceso de monitorización o de
  cambios) y la revisión de evidencia a la que remite (§7.4).
- **Fechas:** registro, última validación y próxima revisión.

## 6. El informe de validación

`<run>.validation/<revisión>.json` (`validation_report@1`) más una versión legible. Se genera desde el diario, el
finding, la auditoría y los lotes. Cada línea lleva su fuente (R1).

1. **Descripción:** el artefacto como código, sus supuestos (las creencias del investigador), sus tres capas y su
   contexto de uso con los criterios declarados.
2. **Resultados, cada uno por separado** (R6):
   - **Aceptación predictiva:** el protocolo lo aceptó (check, familia, confirmación a ciegas), con los hechos por lugar.
   - **Evidencia discriminante prerregistrada:** las pruebas propias severas superadas como prerregistradas, con la
     respuesta del Judge sobre si cada rival era genuino. Que un modelo derrote a un rival concreto no demuestra
     corrección general.
   - **Adecuación al contexto de uso:** si cumple los criterios declarados para ese uso, que pueden pedir sólo
     predicción o también acierto bajo intervención.
   - **Recuperación mecanística**, donde hay verdad: la calificación con el calificador endurecido, con la rúbrica y el
     calificador usados. Una recuperación baja no convierte la aceptación en falsa, y sólo establece eso: una
     recuperación baja según esa rúbrica y ese calificador. Puede deberse a una explicación incompleta, a un desajuste
     de la rúbrica o a un error de evaluación.
3. **Verificación del proceso**, con cada prueba por su nombre (R7):
   - el contrato del instrumento (I1–I6) en la versión del run;
   - la **consistencia de reproducción**: un run reanudado que no diverge. Acredita el registro, no que el instrumento
     responda hoy lo mismo;
   - la **reejecución en vivo**, cuando se hace: los mismos `act` contra el instrumento actual, comparados con lo
     grabado;
   - los informes del instrumento con su veredicto.
4. **Referencias:** las líneas base del operador y los rivales públicos.
5. **Robustez del artefacto** (R8): el mismo modelo, con sus dependencias congeladas, evaluado en episodios nuevos,
   otras familias del contexto de uso e intervenciones, mediante la reevaluación sintética (§9). Y los nombres neutros
   frente a los reales, donde aplica. **No** se toma de la variación entre semillas de los lotes: cada run produce su
   propio modelo, y esa variación caracteriza al generador (punto 8), no a este artefacto.
6. **Registro de limitaciones:**
   - contraejemplos abiertos;
   - informes del instrumento pendientes o con veredicto `bug`;
   - fallos tolerados;
   - aceptación trivial;
   - aceptación retenida;
   - hallazgos no recuperados;
   - y la distancia entre la adecuación declarada y la recuperación mecanística.
7. **Independencia** en sus tres dimensiones (§7).
8. **Configuración generadora:** su caracterización en el momento del run (§8.2), incluida la **variabilidad del
   generador**: qué producen investigaciones independientes con la misma configuración (SPEC-CONTROL-ARNES §6). Es
   contexto sobre el proceso, no evidencia sobre este artefacto.
9. **Conclusión propuesta**, como borrador. Las conclusiones firmadas no van dentro del informe: son archivos aparte
   que remiten al manifiesto (§7.4).

## 7. Roles, independencia y aprobación

### 7.1 Los roles

| rol | en el arnés |
|---|---|
| **Desarrollador** | el junior: su LLM y su configuración |
| **Director** | el senior, si lo hubo, y el operador con sus mensajes |
| **Validador técnico** | el calificador (`GRADER_LLM_*`), el Judge de la auditoría, las pruebas del contrato |
| **Aprobador** | una persona identificada |

### 7.2 Tres dimensiones de independencia, registradas por separado

- **Diversidad técnica:** si el validador técnico usa otro modelo y otro proveedor que el desarrollador y el director.
  Es útil, pero no establece independencia: dos modelos distintos pueden compartir errores o recibir el mismo encuadre
  sesgado.
- **Separación del proceso de evaluación:** qué vio el validador. Por ejemplo, si leyó el razonamiento del desarrollador
  o sólo su modelo y sus resultados, si el encuadre de su tarea lo escribió el mismo operador que dirigió el run y si
  participó en el desarrollo.
- **Independencia organizativa:** autoridad, separación de responsabilidades y capacidad de cuestionar el desarrollo.
  La declara una persona; el arnés no la calcula. Es la dimensión que exigen los marcos bancarios, como el principio 4
  de SS1/23.

El informe muestra las tres. Ninguna se resume en «independiente: sí o no».

### 7.3 Qué firma el aprobador

Una conclusión (`aprobado`, `aprobado con limitaciones` o `rechazado`) sobre una revisión concreta, con su identidad,
fecha y nota.

### 7.4 Evidencia inmutable

**Tres piezas, físicamente separadas, en este orden:**
1. **El informe cerrado.** Una vez cerrado no cambia; ninguna firma se escribe dentro de él.
2. **El manifiesto.** Contiene los hashes de:
   - el informe cerrado;
   - el artefacto;
   - el contexto de uso y sus criterios;
   - el diario, el finding y la auditoría;
   - las calificaciones;
   - los informes de lote de los que salieron las estadísticas.
3. **La aprobación.** Un archivo propio que remite al hash del manifiesto, con la identidad del aprobador, la fecha, la
   conclusión y su nota.

Así una firma nunca cambia el hash de lo firmado.

**Almacén de copias inmutables.** Un hash detecta un cambio, pero no permite reconstruir lo que cambió. Por eso cada
contenido citado en un manifiesto se copia, al cerrar la revisión, a un almacén por contenido
(`runs/models/evidence/<hash>`), de sólo lectura. Si después el finding se recalifica y se sobrescribe, lo aprobado sigue
ahí tal como era.

**Verificación al abrir.** Abrir una revisión (consola o `lab model show`) recalcula los hashes de sus copias y los
compara con el manifiesto. Una discrepancia se muestra como error de integridad y bloquea cualquier firma sobre esa
revisión.

**Revisiones nuevas:**
- **Recalcular cualquier cosa crea una revisión nueva,** se trate de una recalificación con otro calificador, un lote
  recalculado o un veredicto nuevo sobre un informe del instrumento. Lo firmado no se toca.
- **Si la revisión nueva contradice los criterios aprobados,** es decir, si algún resultado de §6.2 que la aprobación
  daba por cumplido ya no se cumple, o aparece una limitación nueva que afecta al contexto de uso, la aprobación anterior
  **se suspende**: el modelo pasa a `revalidar` y deja de estar vigente hasta que se firme una revisión.
- **Si la revisión nueva no contradice nada,** la aprobación anterior sigue vigente, con una nota que remite a la
  revisión más reciente sin firmar.
- La comparación entre revisiones la hace el arnés y queda en el historial. Que contradiga o no lo decide la regla de
  arriba, no una persona.

**El historial de estados** (§5) enlaza cada cambio con su revisión y, si lo hubo, con la contradicción que lo motivó.

## 8. Cambios y caracterización de la configuración generadora

### 8.1 Disparadores de revalidación

Un modelo inventariado pasa a `revalidar` cuando:
- **cambia una dependencia de ejecución**, por ejemplo el modelo de Jev para una ley con reglas, el ejecutor o la
  versión de la percepción;
- **cambia la versión del instrumento** del mundo: un commit que toca el laboratorio, el servicio o el simulador, o un
  `bug` confirmado;
- **cambia el contexto de uso** o sus criterios;
- **la monitorización observa deriva** (§9);
- **vence su fecha de revisión.**

Cambiar la configuración generadora no lo pone en `revalidar` (el artefacto no cambia). Sí obliga a caracterizar de
nuevo esa configuración antes de producir modelos con ella.

### 8.2 La caracterización de la configuración generadora

`runs/models/generators/<proveedor>-<modelo>-<config>.json`, desde los lotes. Es un control interno, no la
correspondencia con ninguna guía (§1.2).
- Identificador, versión y fecha de las mediciones.
- Resultados por condición y población (mundo, criterios y versión del código), con su incertidumbre: tasas de
  aceptación predictiva, de evidencia discriminante y de adecuación, y coste total (SPEC-CONTROL-ARNES §4).
- Modos de fallo observados: `llm_error`, `diverged`, insubordinación, consumo del presupuesto.
- Alternativa caracterizada.
- Límites conocidos.

## 9. Reevaluación y monitorización

Son dos cosas distintas, y el informe las llama por su nombre (R7):

- **Reevaluación sintética** (`lab model reevaluate <id>`): ejecuta el artefacto, con sus dependencias en la versión
  inventariada, sobre episodios nuevos del simulador de su contexto de uso. Mide el comportamiento dentro de esa
  distribución congelada. Es lo único que el arnés puede hacer por sí solo.
- **Monitorización en uso:** compara el artefacto con observaciones actuales del sistema real en el que se usa. Exige
  una conexión con ese sistema que el arnés no tiene. Hasta que exista, no se habla de deriva en producción.
- **Lo que pasa a `revalidar`:** cualquier resultado de una reevaluación por debajo de sus criterios, o un cambio de
  dependencia que el inventario detecte. El informe dice cuál de las dos lo motivó.

## 10. Perfiles y referencias

### 10.1 El registro de referencias

Cada correspondencia normativa se registra con:
- **documento, edición y apartado;**
- **aplicabilidad:** si el texto se aplica a este caso, se adapta o no se aplica;
- **evidencia disponible** en el arnés;
- **estado:** `contrastado` (con el texto) o `por contrastar`.

Estado conocido el 07/10/2026:

| documento | edición | apartado | aplicabilidad | estado |
|---|---|---|---|---|
| Fed, SR 26-2, *Revised Guidance on Model Risk Management* | 17/04/2026 (sustituye a SR 11-7 y SR 21-8) | nota 3: IA generativa y agéntica fuera de alcance | no se aplica al LLM investigador | contrastado |
| Fed, SR 26-2 | 17/04/2026 | sección VII, productos de proveedores y otros terceros | se aplicaría, en su caso, al artefacto cuantitativo según su uso | contrastado (existencia); correspondencia por contrastar |
| PRA, SS1/23, *Model risk management principles for banks* | edición del 23/04/2026 (LIAF01/26) | principio 4, validación independiente | marco de referencia para §7.2 | edición contrastada; contenido por contrastar con la edición vigente |
| NASA-STD-7009B | 05/03/2024 (cambio 1) | evaluación de credibilidad en las fases de desarrollo y uso | adaptación a simulación industrial | estructura contrastada; correspondencia por hacer |
| ASME V&V 40 | — | riesgo del modelo según su influencia y la consecuencia | **adaptación**: la norma está orientada a dispositivos médicos | por contrastar |

### 10.2 Perfil bancario

Se aplica al **artefacto cuantitativo** cuando una organización bancaria lo usa, nunca al LLM investigador. La
correspondencia con SR 26-2 y SS1/23 se construirá apartado por apartado desde los textos vigentes. Las tablas de memoria
de la primera versión de esta spec se retiran. Criticidad: la clasificación que use la organización.

### 10.3 Perfil industrial

- **NASA-STD-7009B organiza la credibilidad por fases de desarrollo y uso.** La correspondencia con las evidencias de
  §6 se construirá desde su texto, no desde la estructura de la revisión A.
- **El riesgo del modelo se toma de ASME V&V 40, como adaptación.** Combina cuánto influye el modelo en la decisión con
  la consecuencia de una decisión equivocada: a más riesgo, más evidencia exigida. El inventario guarda los dos ejes.

## 11. Medidas

- Modelos inventariados por estado y criticidad.
- Proporción con una revisión firmada vigente, sin dependencias cambiadas desde la firma.
- Tiempo desde la aceptación hasta la primera firma.
- Limitaciones por modelo y cuántas se cierran.
- Revalidaciones por causa: dependencia, instrumento, contexto, reevaluación o fecha.
- Las tres dimensiones de independencia, por separado.

## 12. Plan

En el orden que propone la auditoría:
- **M1. Informe trazable con revisiones inmutables** (§6, §7.4): manifiesto con hashes, revisiones nuevas al
  recalcular, conclusión firmada vinculada a una revisión. Más los resultados separados (R6) y la verificación del
  proceso con cada prueba por su nombre (R7).
- **M2. Métricas descriptivas con incertidumbre** (SPEC-CONTROL-ARNES K1).
- **M3. Inventario y dependencias de ejecución** (§4, §5, §8.1), con el historial de estados.
- **M4. Las tres dimensiones de independencia** (§7.2).
- **M5. Reevaluación sintética** (§9) y caracterización de la configuración generadora (§8.2).
- **M6. Perfiles normativos** (§10), cuando los criterios estén fijados y las correspondencias contrastadas.

**Preguntas abiertas:**
- ¿Dónde firma la persona? Propuesta: `lab model approve <id> --revision <hash>` y la consola, siempre sobre una
  revisión.
- ¿Quién declara los criterios de adecuación del contexto de uso? Propuesta: el propietario del modelo, antes de
  evaluar. El cambio de criterios crea una revisión nueva.
- ¿Se inventarían modelos de mundos sin verdad (como `tank`)? Propuesta: sí, sin recuperación mecanística, con más peso
  en la evidencia discriminante.

## 13. Auditoría externa (07/10/2026): qué cambió

- **Referencias normativas:**
  - SR 11-7 está sustituida por SR 26-2 (17/04/2026), que excluye la IA generativa y agéntica. Contrastado con la
    fuente.
  - El LLM ya no se presenta como modelo de proveedor de la guía bancaria; la configuración generadora se caracteriza
    con controles propios (§8.2).
  - SS1/23 tiene edición de 23/04/2026, y la revisión vigente de NASA es 7009B.
  - ASME V&V 40 se toma como adaptación.
  - Cada correspondencia lleva documento, edición, apartado, aplicabilidad y estado de contraste (§10.1). Se retiran
    las tablas de memoria.
- **Resultados separados** (R6, §6.2): aceptación predictiva, evidencia discriminante, adecuación al contexto de uso y
  recuperación mecanística. Nada se llama «correcto».
- **Tercera capa de modelo:** las dependencias de ejecución, incluido Jev para las leyes con reglas. Cambiar una obliga
  a revalidar (§4, §8.1).
- **Independencia en tres dimensiones** (diversidad técnica, separación del proceso, independencia organizativa), sin
  booleano (§7.2).
- **Aprobación vinculada a evidencia inmutable** mediante hashes, con revisiones nuevas al recalcular, identidad del
  aprobador e historial (§7.4). El caso que lo motiva: un lote mostraba 0,25 y el finding recalificado, 0,11.
- **Reproducir, reejecutar, reevaluar y monitorizar son evidencias distintas** (R7, §6.3, §9). Sin conexión a
  observaciones reales, se habla de «reevaluación sintética».
- **El plan se reordena:** primero el informe trazable, las revisiones y las métricas descriptivas; los perfiles
  normativos, al final.

## 14. Segunda auditoría (07/10/2026): qué cambió

- **La robustez del artefacto se separa de la variabilidad del generador** (R8, §6.5, §6.8). La robustez es la del mismo
  modelo congelado en episodios, familias e intervenciones distintos. La variación entre semillas de los lotes describe
  el proceso que genera modelos, y no se hereda en la ficha de un modelo concreto.
- **La evidencia inmutable conserva contenidos, no sólo hashes** (§7.4):
  - almacén de copias por contenido, de sólo lectura, con verificación de integridad al abrir;
  - separación física entre el informe cerrado, el manifiesto y la aprobación, para que ninguna firma cambie el hash
    de lo firmado;
  - una revisión nueva que contradice los criterios aprobados suspende la aprobación anterior y pasa el modelo a
    `revalidar`.
- **Inferencias más prudentes:**
  - una recuperación baja sólo establece eso, según esa rúbrica y ese calificador (§6.2);
  - de `c302nav` hay evidencia favorable para anticipar señales en las condiciones evaluadas, y evidencia insuficiente
    para justificar su uso al diseñar intervenciones (§1.3).
