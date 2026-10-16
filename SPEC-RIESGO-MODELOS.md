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

## 15. Implementado

### 15.1 El paquete de investigación: primera parte de M1, con R6 y R7 (16/10/2026)

Es el punto 3 del cierre de la auditoría externa del 16/10/2026: un run hecho autocontenido, que se puede llevar a otra
máquina, comprobar y reconstruir (`lib/src/runtime/package.ts`, `test/package.test.ts`).

- **`lab pack <run> [--out dir]`** crea `<run>.package/` con:
  - el diario, con su mundo archivado dentro;
  - el registro de repetición;
  - los findings y los registros de sus agentes;
  - los blobs que cita.
- **Además escribe:**
  - `manifest.json`, con formato `research_package@1`: cada fichero con su sha256 y su tamaño, el commit y los blobs
    citados que no se encontraron. Si falta alguno, el paquete lo dice y el comando termina con error.
  - `report.json`, con los resultados separados, cada uno por su nombre (R6):
    - aceptación predictiva del modelo;
    - aceptación predictiva del artefacto, con su cadena y su linaje;
    - evidencia discriminante (las pruebas propias);
    - adecuación a un uso, que de momento es "no declarada";
    - recuperación mecanística, o "sin verdad / sin calificar";
    - las limitaciones y el coste (K1, en lo que el finding ya tiene).

    Ninguno se llama "correcto".
- **`lab verify <package> [--llm-path /v1/...]`** escribe `verification.json` aparte de lo que verifica (§7.4). Nombra
  cada prueba (R7):
  - **Integridad:** cada fichero se recalcula contra el manifiesto. Cuenta lo cambiado, lo que falta, lo que no está en
    el manifiesto y los blobs que nunca se empaquetaron.
  - **Reconstrucción desde el registro:** el run se reanuda en una copia temporal, sin red. Cada respuesta sale de su
    registro. Una petición que el registro no contiene se rechaza, nunca se vuelve a hacer. Sus eventos se comparan uno a
    uno, sin contar sus tiempos.
  - **Reejecución y reproducción:** constan como "no hechas", con lo que necesitaría cada una y las huellas de entorno
    registradas. Así nadie las confunde con la primera (SPEC-MUNDO-ARTEFACTOS §11).
- **El diario guarda ahora `config.llm_path`:** la ruta del endpoint de System 2, nunca su host ni sus parámetros. Forma
  parte de la identidad de cada petición, así que sin ella no se puede reconstruir sin red. La verificación también
  restaura el ajuste registrado (`llm_tuning`).
  - Un diario anterior no tiene esa ruta. Se toma la que se pase o, si no, `/v1/chat/completions`.

**Pendiente de M1:** hecho en §15.3.

**Pendiente de la verificación:**
- Reconstruye el run, no los procesos de sus agentes (el senior). Los registros de los agentes viajan en el paquete y su
  integridad se comprueba, pero sus peticiones no se reconstruyen.

### 15.2 Revisión externa del paquete (16/10/2026)

Una revisión externa encontró seis fallos reproducibles y una inestabilidad. Todos quedan corregidos, cada uno con su test
(`test/package.test.ts`, `test/artifacts-because.test.ts`):

1. **`pack --out` podía borrar la investigación.** El destino se vaciaba sin mirar qué contenía. Ahora nunca se escribe en
   la carpeta del run ni en una que la contenga, y una carpeta que ya existe sólo se reemplaza si es un paquete.
2. **Un blob corrupto antes de empaquetar pasaba la integridad.** Sólo se comprobaba fichero contra manifiesto. Ahora se
   comprueba también la referencia contra el contenido: el nombre de cada blob citado es su sha256.
   - Al empaquetar, uno que no coincide no se copia y consta en `corrupt_blobs`.
   - Al verificar, se recalcula, aunque el manifiesto se haya retocado para coincidir.
3. **La verificación no podía reconstruir runs con el Judge:** exigía su clave. Ahora el Judge se configura como lo tuvo el
   run (su modelo) y responde sólo desde el registro. No hace falta clave porque nada sale.
4. **La comparación ignoraba el cierre.** Ahora se compara el evento `end` entero, salvo lo que es del proceso y no de la
   investigación: el tiempo, cómo llegaron las respuestas (`replay`, `console_usage`), qué reanudó y trajo, y dónde
   reanudarlo. Un modelo final cambiado ya no pasa (`end_differs`).
5. **La cadena del producto confundía contenido con procedencia.** Con base→A, base→B y B→A, el linaje de A tomaba la
   primera ruta.
   - Ahora el linaje sigue los cambios tal como ocurrieron, cada uno con su número (`change`): el que hizo la versión por
     última vez, y antes de él, el que hizo a su padre.
   - Las dependencias de una creencia caída marcan si el *cambio* está en la línea de la última versión, no si lo está el
     contenido.
6. **Un run detenido por presupuesto no se verificaba,** porque la reanudación intentaba continuar. Ahora, si el registro
   se paró antes de tiempo (presupuesto de tokens o de tiempo, cancelación), la reconstrucción se para donde él se paró
   (`stopAsRecorded`, sólo desde código), y su cierre se sirve del registro.

**La inestabilidad** venía de que el linaje del producto sólo existía si el artefacto se aceptaba, y eso depende de una
medición real. Ahora el linaje acompaña a la versión que nombra el finding: la última aceptada o, si no hay ninguna, la
última comprobada.

**Además,** el paquete incluye ahora la auditoría del método (`.method.json`) y los veredictos del operador
(`.anomalies.jsonl`). La reanudación lee los veredictos, así que sin ellos un run que los tuvo no se reconstruiría.

### 15.3 Revisiones inmutables y la conclusión firmada: M1 completo (16/10/2026)

El código está en `lib/src/runtime/validation.ts` y las pruebas en `test/validation.test.ts`.

- **`lab model revise <run> [--use "<contexto>"] [--criteria "<criterios>"]`** crea una revisión del informe de
  validación (§6):
  - descripción, con el modelo, el artefacto y los supuestos (las creencias);
  - resultados separados (R6);
  - verificación del proceso con cada prueba por su nombre (R7): el run se empaqueta y se verifica (§15.1), y se
    incluyen los informes del instrumento;
  - referencias;
  - robustez, que consta como "no hecha" (M5);
  - limitaciones;
  - independencia en sus tres dimensiones: la diversidad técnica con los modelos de cada rol, la separación "no
    registrada" (M4) y la organizativa "declarada por una persona: no declarada";
  - configuración generadora;
  - coste;
  - una conclusión propuesta como borrador, por una regla que se enuncia.

  Cada parte nombra su fuente (R1).
- **La revisión, cerrada:**
  - el informe, el contexto de uso y cada contenido en que se apoya se copian por su sha256 a
    `runs/models/evidence/<sha256>`, en sólo lectura: el diario, el registro de repetición, los findings, la auditoría,
    los veredictos y los blobs;
  - el manifiesto (`validation_manifest@1`) los nombra a todos, y **su hash es la revisión**;
  - junto al run quedan `<run>.validation/<rev>/report.json`, `report.txt` (la versión legible) y `manifest.json`.
- **Recalcular:** si nada cambió, sale la misma revisión. Si cambió cualquier cosa (una recalificación, un veredicto, otro
  contexto de uso u otros criterios), sale una nueva, y el arnés la compara con la aprobada por esta regla:
  - la contradice si un resultado que la aprobación daba por cumplido ya no se cumple: aceptación del modelo o del
    artefacto, contraejemplos cerrados, integridad o reconstrucción;
  - también la contradice si aparece una limitación que no tenía;
  - si la contradice, la aprobación se suspende y el estado pasa a `revalidate`;
  - si no, la aprobación sigue vigente, con una nota que remite a la revisión posterior sin firmar.

  Todo queda en `<run>.validation/history.jsonl`.
- **`lab model approve <run> --revision <id> --by "<persona>" --conclusion approved|approved_with_limitations|rejected
  [--note ...]`:** la conclusión de una persona, en un archivo propio (`approvals/`) que remite a la revisión. La firma
  nunca cambia el hash de lo firmado.
  - Se rechaza si firma un agente (`agent:`).
  - Se rechaza si la evidencia de la revisión no se sostiene.
- **`lab model show <run>`:** abre cada revisión, recalcula sus copias, y muestra las aprobaciones y el estado. Una
  discrepancia aparece como error de integridad.

**Decisión de diseño.** Cualquier limitación nueva cuenta como contradicción, aunque §7.4 habla de una "que afecta al
contexto de uso". El arnés no puede juzgar si le afecta, así que suspende y deja que lo decida la persona al firmar de
nuevo. Es la opción prudente.

**Pendiente:**
- ~~el inventario y el historial de estados por modelo (M3)~~: hecho en §15.4;
- los informes de lote como evidencia, cuando las estadísticas salgan de ellos (M2);
- ~~la separación del proceso de evaluación (M4)~~: hecho en §15.5;
- ~~la reevaluación sintética (M5)~~: hecho en §15.6.

### 15.4 El inventario y las dependencias de ejecución: M3 (16/10/2026)

El código está en `lib/src/runtime/inventory.ts` y las pruebas en `test/inventory.test.ts`. El inventario vive en
`runs/models/inventory.json` (`model_inventory@1`).

- **`lab model register <run> --owner "<persona>"`** inventaría el modelo de un run. Opciones:
  `--use "..."`, `--criteria "..."`, `--influence` y `--consequence` (low, medium o high), `--criticality "<la clase de
  la organización>"`, `--review-days N` e `--id`.
  - **El propietario es una persona,** nunca un agente.
  - **El contexto de uso es obligatorio.** Se toma de `--use` o, si no se da, de la revisión que lo declare.
  - **Las tres capas** (§4):
    - la configuración generadora: investigador, modelo y ajuste del LLM, modelo del Judge, configuración del arnés,
      agentes y presupuesto de ayuda;
    - el artefacto, con la huella del modelo final y la versión del artefacto;
    - las dependencias de ejecución tal como están al inventariar.
  - **La criticidad,** en los dos ejes de V&V 40 o en la clase de la organización.
  - **El historial de estados,** las fechas (registro, última validación, próxima revisión) y los fallos del instrumento
    conocidos.
- **Las dependencias de ejecución** son:
  - el runtime que ejecuta el código del modelo;
  - el Judge y su modelo, sólo cuando la ley tiene reglas;
  - el instrumento del mundo;
  - lo que el mundo declara necesitar, mediante un gancho nuevo y opcional del laboratorio: `Lab.dependencies(spec)`.
    En el mundo de artefactos es el entorno donde se miden sus versiones, con su huella y sus hechos.
- **El instrumento** es el código del mundo y el que usa fuera del arnés, encontrado por sus imports: en artefactos,
  `lib/src/artifacts`. Nunca incluye el arnés (`learn`, `runtime`, `orchestra`, `core`, `audit`).
  - Su huella se calcula sobre el contenido con finales de línea LF, así que da lo mismo en cualquier sistema.
  - Si al inventariar git dice que cambió desde el commit del run, el modelo nace en `revalidate`.
- **`lab model check [<id>]`** aplica los disparadores de §8.1:
  - una dependencia distinta de la inventariada;
  - el instrumento cambiado, o un fallo suyo (`bug`) confirmado por el operador después de inventariar;
  - el contexto de uso o los criterios de la última revisión distintos de los del inventario;
  - la fecha de revisión vencida;
  - el run desaparecido.

  Cada disparador pone el modelo en `revalidate`, por el arnés y con su causa, y la misma causa se registra una sola vez.
  El modelo sigue ahí hasta que una persona firma una revisión **después** del disparador. Esa firma vuelve a inventariar
  el modelo tal como está: sus dependencias, sus fallos conocidos y su contexto, y cuenta la próxima revisión desde ella.
  Sin disparadores, el estado es el de su validación (M1): en validación, la conclusión firmada (por quien la firmó y con
  su revisión) o suspendida por una revisión.
- **`lab model list`** muestra los modelos con su estado. **`lab model retire <id> --by "<persona>"`** retira uno.
- **Cambiar la configuración generadora** no pone un modelo en `revalidate` (§8.1): se guarda, pero no se compara.

**Pendiente:**
- **El simulador de los mundos c302** es un servicio externo. No forma parte de su instrumento mientras el mundo no
  declare su versión en `dependencies`.
- ~~**La reevaluación sintética como disparador** (§9, M5)~~: hecho en §15.6.
- **Las medidas de §11** sobre el inventario.

### 15.5 Las tres dimensiones de independencia: M4 (16/10/2026)

La sección de independencia del informe de validación es ahora la de §7.2. Va construida desde lo registrado, con sus
tres dimensiones por separado y sin ningún «independiente: sí o no» (`lib/src/runtime/validation.ts`,
`test/independence.test.ts`).

- **Los roles:**
  - el desarrollador: el modelo del junior y su proveedor;
  - los directores: los agentes (senior, coach) con su modelo y su proveedor, y los mensajes del operador;
  - los validadores técnicos: cada calificación en su última versión (por tipo y sujeto), el Judge de la auditoría del
    método y las comprobaciones del entorno.
- **Diversidad técnica:** para cada validador, si comparte modelo o proveedor con el desarrollador y si comparte modelo
  con algún director. Siempre va con la lectura «diversidad, no independencia».
- **Separación del proceso de evaluación:** para cada validador, qué se le dio y si entre eso estaba el razonamiento del
  desarrollador (notas, reflexiones, justificación, lecciones, métodos). También quién encuadró su tarea (el prompt del
  arnés, fijado en su código, o las preguntas de la auditoría) y si participó en el desarrollo: su modelo es el del
  desarrollador o el de un director.
  - El calificador dentro del run usa el modelo del propio junior y lee su razonamiento. Ahora se dice.
- **Independencia organizativa:**
  `lab model independence <run> --by "<persona>" --validator "<quién validó>" [--reports-to ...] [--separate yes|no]
  [--can-challenge yes|no]`. La declara una persona, nunca un agente, y el arnés no la calcula.
  - Se guardan todas las declaraciones en `<run>.validation/independence.jsonl` y vale la última.
  - Entran como evidencia en la siguiente revisión, junto con los registros de los agentes.

**Lo que se registra ahora para esto:**
- **El proveedor como identidad, nunca como dirección:** los primeros 16 hex del sha256 del host del endpoint
  (`runtime/provider.ts`).
  - En el diario: `llm_provider` y `jev_provider`.
  - En la calificación: `grader_provider`, tanto dentro del run como en `lab grade`.
  - En el registro del agente: `llm_provider`.
  - El cliente LLM sólo expone su endpoint en memoria (`ChatClient.endpoint`) y nunca lo registra.
- **Cada calificación registra lo que vio:** `saw` (las partes por su nombre), `saw_reasoning` y `framing`.
- **La auditoría del método registra lo que vio su Judge** (`judge_saw`).
- **Se corrige una etiqueta mal puesta:** el calificador de la cuadrícula usa el cliente del operador, pero registraba
  como `grader_model` el modelo del junior.

**Dos correcciones de la verificación (§15.1) que salieron al probar esto:**
- **Una recalificación no rompe la reconstrucción.** `lab grade` añade su evento después del cierre: es una lectura
  posterior del operador, no parte del run. Lo reconstruido son los eventos hasta el cierre, y los posteriores se cuentan
  aparte (`later_readings`).
- **Lo que el registro guardó debe salir igual, campo a campo.** Lo que una versión posterior del arnés registra de más
  (por ejemplo, `saw`) no cuenta como diferencia. Sin esta regla, ningún run anterior a un campo nuevo se podría
  verificar con el código actual.
  - La reconstrucción sin red conserva además el proveedor que tuvo el run.

### 15.6 Reevaluación sintética y caracterización de la configuración generadora: M5 (16/10/2026)

**Reevaluación sintética (§9).** `lab model reevaluate <id> [--places N]` (`lib/src/runtime/inventory.ts`,
`test/reevaluation.test.ts`).

- **Qué se reevalúa:** el modelo con el que terminó el run, congelado (`end.final`, reconstruido con `buildLaw`), y, si lo
  hay, la versión de su artefacto.
- **Cómo:** con el protocolo del propio mundo, en lugares nuevos de su familia y sin System 2. Es un modo del runner
  (`LabRunOptions.reevaluate`) que se salta la exploración y las preguntas.
  - Cada reevaluación toma un tramo de lugares propio (`set` 9000 + n).
  - Las versiones del artefacto se rehacen desde el registro, cambio a cambio, mediante un gancho nuevo y opcional del
    laboratorio: `Lab.rebuild(spec, events)`. Como el contenido va por hash, salen las mismas versiones.
- **Con sus dependencias tal como se inventariaron.** Si una no lo está, la reevaluación se rechaza, porque evaluaría otra
  cosa: eso es revalidar.
  - Si la ley tiene reglas, hace falta el Judge con el modelo inventariado.
  - Si no las tiene, la reevaluación no pide nada a la red.
- **Por debajo de sus criterios:** si no se sostiene en alguno de los lugares nuevos (su aceptación pedía todos), el
  modelo pasa a `revalidate` por el arnés, con la causa `reevaluation`. Si se sostiene, queda anotado en el historial.
- **Cada reevaluación queda guardada:** su diario va a `<run>.validation/reevaluations/r<n>.json` y su resumen al
  inventario.
- **En el informe de validación entran como robustez** (§6.5, R8), con su fuente y como evidencia de la revisión. Se lee
  así: «dentro de la distribución congelada, no el sistema real». Constan como no hechas otras familias del uso y las
  intervenciones.

**Caracterización de la configuración generadora (§8.2).** `lab model characterize <batch.json> [...]`
(`lib/src/runtime/generators.ts`, `test/generators.test.ts`) escribe
`runs/models/generators/<proveedor>-<modelo>-<config>.json` (`generator_characterization@1`).

- **La configuración** es el LLM con su ajuste y su proveedor, el modelo del Judge, el investigador, los agentes con su
  modelo y su proveedor, y los ajustes del arnés. **Nunca el mundo:** su semilla y sus opciones son la población.
- **Por población** (mundo y versión del código) da:
  - la aceptación predictiva del modelo y la del artefacto;
  - la evidencia discriminante: pruebas propias severas sin contraejemplos abiertos;
  - cada tasa con su intervalo del 95% (Wilson, correcto con pocos runs y en los extremos);
  - el coste: mediana y cuartiles de tokens y llamadas;
  - los modos de fallo, cada uno con su tasa (`llm_error`, `diverged`, presupuesto agotado, cancelación). La
    insubordinación consta como «no medida».

  También lista los runs medidos y los lotes de los que salen.
- **Medir de nuevo añade una caracterización,** y las anteriores se quedan.
- **Se lee como control interno del proceso:** nunca es evidencia sobre ninguno de sus modelos (R8).

**Pendiente:**
- **Exigir la caracterización antes de producir modelos con una configuración nueva** (§8.1). Hoy se mide, pero no se
  exige.
- **La adecuación por población,** cuando los runs declaren criterios.
- **Medir la insubordinación.**
- **Reevaluar en otras familias del uso y con intervenciones.**

### 15.7 Revisión externa de M1–M5 (16/10/2026)

Una revisión externa encontró seis fallos. Todos están corregidos, cada uno con su test. El hilo común es que las
garantías deben mantenerse **entre componentes y a lo largo del tiempo**.

1. **Una aprobación seguía vigente con su evidencia corrupta.** `validationState` lo detectaba, pero mantenía el estado
   firmado. Ahora la firma se conserva tal como se hizo, pero sólo está vigente mientras lo firmado se sostenga. Si la
   evidencia de la revisión firmada no se sostiene al abrirla, el estado pasa a `revalidate` con esa causa, y el
   inventario lo sigue.
2. **La reconstrucción de runs que consultaron al Judge divergía.** La ruta del endpoint forma parte de la identidad de la
   petición, y el verificador usaba otra. Ahora el diario guarda `config.jev_path` (nunca el host) y la reconstrucción la
   usa. Un diario anterior toma la ruta por defecto del Judge. El test anterior no lo detectaba porque sus reglas vacías
   nunca llegaban a consultar al Judge; el nuevo sí lo consulta.
3. **La procedencia de un artefacto aceptado podía cambiar después.** Ejemplo: A se acepta en la ronda 1 y en la ronda 2
   se vuelve a A por otro camino. Ahora el camino por el que se hizo la versión queda fijado en el momento de aceptarla,
   y el linaje del producto aceptado es ése. El test confirma que sin el arreglo falla.
4. **Las revisiones guardaban la conclusión de cada reevaluación, pero no sus mediciones.** Ahora copian también el
   registro de repetición de cada reevaluación (donde están sus ejecuciones medidas) y los blobs que cita cada diario
   (el del run y los de sus reevaluaciones).
   - Un blob que falta o cuyo contenido no es el que nombra se anota en el manifiesto (`unkept`).
   - Esa revisión deja de sostenerse, así que no puede firmarse.
5. **La caracterización mezclaba configuraciones del senior.** La identidad de un agente incluye ahora toda la
   configuración de sus peticiones (`llm_config`: esfuerzo de razonamiento, temperatura...) y los ajustes de su rol, que
   el registro del agente guarda en `settings`. Un senior en `low` y otro en `high` son dos generadores.
6. **`lab pack` daba éxito con blobs corruptos.** La CLI miraba sólo los que faltaban. Ahora también los corruptos dan
   código de error, con su aviso.
