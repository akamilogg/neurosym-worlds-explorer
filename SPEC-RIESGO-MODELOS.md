# SPEC · Gestión del riesgo de modelos: el arnés como evidencia de validación

Estado: propuesta (07/10/2026). Nada implementado. Va de la mano de SPEC-CONTROL-ARNES, que mide el arnés como un
proceso controlado. Esta spec decide qué evidencia produce cada modelo aceptado y quién la firma.

## 1. De dónde sale

### 1.1 La cadena de razonamiento

La spec es el último eslabón de una conversación que empezó lejos del código (07/10/2026):

1. **La curva S de lo digital.** La era digital son tres curvas anidadas: TIC (madura), IA sobre dominios ya digitales
   (en plena subida) y digitalización del mundo físico y biológico (antes de su inflexión). Su retrato está en el
   artefacto «La curva S de lo digital».
2. **Digitalizar tiene niveles:** registrado (N1), predecible (N2), mecanístico (N3, acierta bajo intervención) y
   diseñable (N4, lazo cerrado). La IA actual lleva dominios a N2 con facilidad. El valor económico está en N3 y N4.
3. **El cuello de botella pasa de generar a verificar.** En nuestros runs, el par junior y senior razona por céntimos,
   y lo caro es el experimento y saber si el resultado es correcto. Cuando generar es barato, lo escaso es la
   validación.
4. **De ahí, una pregunta de carrera.** ¿Qué hace un ingeniero de software cuando la IA programa mejor que él? La
   respuesta salió del propio proyecto. El autor no escribió el código, pero tomó las decisiones que le dieron valor:
   - vio que el modelo aceptado era una sombra;
   - formuló que en un mundo simulado la realidad puede ser un bug;
   - diseñó la relación entre junior y senior;
   - juzgó los runs por el método, no por el resultado.

   El rol es diseñar el sistema dentro del cual trabajan las IAs, decidir qué cuenta como éxito y detectar cuándo el
   éxito es falso.
5. **La banca ya tiene una disciplina para esto.** El autor viene de banca y comercio online. La gestión del riesgo de
   modelos bancaria (SR 11-7) tiene casi las mismas piezas que el arnés:

   | banca | arnés |
   |---|---|
   | modelo retador | rival que explica la evidencia compartida |
   | backtesting | checks |
   | validación fuera de muestra y de periodo | familia de validación y confirmación a ciegas |
   | registro de auditoría | diario y reproducción |
   | calidad del dato | contrato del instrumento |

   La industria, hacia donde quiere ir el autor, está metiendo IA en planta sin una cultura de validación tan formal, y
   empieza a tener presión regulatoria.
6. **La pregunta del autor:** ¿puede el arnés implementar SR 11-7?

### 1.2 La respuesta corta

No como norma, sí como evidencia. SR 11-7 es una guía de supervisión sobre cómo una **organización** gestiona sus
modelos: roles, políticas, consejo, auditoría interna. Eso no lo hace un programa. Lo que el arnés puede hacer es
implementar los **controles técnicos** que la guía pide y generar la **evidencia** que un validador o un supervisor
leería. Más de la mitad ya existe; esta spec cierra los huecos.

### 1.3 Lo que los experimentos añaden a la disciplina bancaria

- **La sombra:** en `c302nav` el protocolo aceptó un modelo que pasaba el check, la familia y la confirmación a ciegas,
  y recuperaba 0,11 de los hallazgos del mecanismo. El backtesting no basta: un modelo puede ser correcto en todo lo que
  se le pregunta y falso en cuanto se interviene. La validación debe incluir pruebas bajo intervención
  (SPEC-PRUEBAS-PROPIAS).
- **El instrumento que miente:** tres fallos del simulador se convirtieron en «leyes» para el investigador. La
  verificación del proceso debe cubrir el instrumento, no sólo el modelo (SPEC-CALIBRACION-INSTRUMENTOS).
- **El LLM es un modelo de proveedor:** un sistema basado en LLMs tiene dos capas de modelo, el modelo que produce el
  investigador y el LLM que lo produce. Bajo SR 11-7, la segunda es un modelo de terceros que también hay que conocer y
  medir.

## 2. Qué no promete

- **No da cumplimiento normativo.** Cumplir SR 11-7, la SS1/23 o la Ley de IA es responsabilidad de una organización.
  El arnés produce evidencia, y la conformidad la declara una persona con autoridad para hacerlo.
- **No sustituye al validador.** El informe de validación es un borrador con hechos verificables. El juicio final
  (aprobado, aprobado con limitaciones, rechazado) lo firma una persona (§7).
- **Las referencias a normas** (SR 11-7, SS1/23, NASA-STD-7009, ASME V&V 40) se resumen de memoria. Antes de presentar
  esta evidencia ante un tercero hay que contrastar cada correspondencia con el texto oficial vigente.

## 3. Principios

- **R1. Evidencia, no declaración.** Cada afirmación del informe de validación apunta a un hecho del diario, del finding
  o de la auditoría. Nada se escribe a mano sin fuente.
- **R2. Dos capas de modelo.** Se valida el modelo aceptado (el artefacto) y se caracteriza el modelo que lo generó: el
  LLM con la configuración del arnés.
- **R3. Independencia declarada, no supuesta.** Cada rol (desarrollo, dirección, validación) lleva su modelo y su
  proveedor. Si el validador no es independiente del desarrollador, el informe lo dice.
- **R4. La validación caduca.** Un modelo aceptado se revalida cuando cambia el instrumento, el LLM, el mundo o pasa su
  fecha. Sin monitorización, no hay validación vigente.
- **R5. Las limitaciones son parte del modelo.** Contraejemplos abiertos, sombras sospechadas, informes del instrumento
  y aceptaciones triviales van al registro de limitaciones, con la misma visibilidad que los aciertos.
- **R6. Dos perfiles, un núcleo.** El núcleo es común; el perfil bancario y el industrial sólo cambian la estructura
  del informe y la clasificación de criticidad (§10).

## 4. Qué es un modelo aquí

- **Modelo aceptado:** la ley o la fórmula que el protocolo aceptó (sus observaciones, reglas, pesos y salida), con su
  huella. Es lo que se usaría.
- **Modelo generador:** el LLM (proveedor, identificador y parámetros: temperatura, esfuerzo de razonamiento), junto con
  la configuración del arnés que lo produjo (investigador, memoria, senior, presupuestos, `--own-tests`).
- **Contexto de uso** (concepto de ASME V&V 40): qué pregunta responde el modelo, en qué rango de condiciones y para qué
  decisión. Sin contexto de uso no hay criticidad ni validación.

## 5. El inventario de modelos

Un archivo por proyecto, `runs/models/inventory.json` (`model_inventory@1`). Una entrada por modelo aceptado que el
operador decide inventariar (`lab model register <run> --use "<contexto de uso>"`):

- **Identidad:** id, huella del modelo, run y commit de origen, versión del instrumento, mundo y lugares.
- **Propietario:** la persona responsable del modelo, que no es un agente.
- **Contexto de uso:** la pregunta, el rango de condiciones (familias, lugares) y la decisión que apoya.
- **Criticidad** (§10): la clase del perfil elegido.
- **Estado:** `en validación`, `aprobado`, `aprobado con limitaciones`, `rechazado`, `revalidar` o `retirado`.
- **Fechas:** registro, última validación y próxima revisión.
- **Enlaces:** el informe de validación vigente y los anteriores.

El estado sólo lo cambia una persona (§7), salvo `revalidar`, que pone la monitorización (§9) o un cambio (§8).

## 6. El informe de validación

`<run>.validation.json` (`validation_report@1`) más una versión legible. Se genera desde el diario, el finding, la
auditoría y los lotes. Secciones del núcleo:

1. **Descripción:** el modelo como código, sus supuestos (lo que el investigador afirmó en sus creencias) y su contexto
   de uso.
2. **Solidez conceptual:**
   - la calificación frente a la verdad, donde existe, con el calificador endurecido;
   - las preguntas del Judge sobre el método (J1–J6);
   - cuántos hallazgos del mecanismo recupera frente a cuánto predice: la medida de sombra.
3. **Verificación del proceso:**
   - el contrato del instrumento (I1–I6) en la versión del run;
   - la reproducción exacta (un run reanudado que no diverge);
   - los informes del instrumento con su veredicto.
4. **Análisis de resultados:** checks, validación en la familia, confirmación a ciegas y regresión emparejada, con sus
   hechos por lugar.
5. **Modelo retador y referencias:** las pruebas propias severas superadas como prerregistradas, las líneas base del
   operador y los rivales públicos.
6. **Robustez:** variación entre semillas y entre familias del mismo contexto de uso (de los lotes), y nombres neutros
   frente a reales donde aplica.
7. **Registro de limitaciones** (R5):
   - contraejemplos abiertos;
   - informes del instrumento pendientes o con veredicto `bug`;
   - fallos tolerados;
   - aceptación trivial (una línea base también la pasa);
   - aceptación retenida;
   - hallazgos no recuperados.
8. **Independencia** (§7).
9. **Modelo generador** (§8.2): su ficha de proveedor en el momento del run.
10. **Conclusión propuesta** (borrador) y **conclusión firmada**, vacía hasta que la firma una persona.

Cada línea lleva su fuente: el evento del diario, el campo del finding o el archivo de auditoría (R1).

## 7. Roles e independencia

El informe registra, para cada rol, quién lo ocupó: persona o agente, con modelo y proveedor si es agente.

| rol | en el arnés | requisito de independencia |
|---|---|---|
| **Desarrollador** | el junior: su LLM y su configuración | — |
| **Director** | el senior, si lo hubo, y el operador con sus mensajes | **no es independiente:** dirige al desarrollador |
| **Validador técnico** | el calificador (`GRADER_LLM_*`), el Judge de la auditoría, las pruebas del contrato | independiente si su proveedor y modelo difieren del desarrollador y del director |
| **Aprobador** | una persona | firma la conclusión; no puede ser el operador que dirigió el run en el perfil bancario |

**Regla:** si el validador técnico comparte modelo con el desarrollador o el director, el informe lo marca como **no
independiente** y la conclusión propuesta no puede ser `aprobado` sin una nota del aprobador.

## 8. Cambios, versiones y el modelo de proveedor

### 8.1 Disparadores de revalidación

Un modelo inventariado pasa a `revalidar` cuando:
- cambia la **versión del instrumento** del mundo: un commit que toca el laboratorio, el servicio o el simulador, o un
  `bug` confirmado (SPEC-CALIBRACION-INSTRUMENTOS §6);
- cambia el **contexto de uso**;
- la **monitorización** detecta deriva (§9);
- vence su **fecha de revisión**.

Un cambio del LLM generador no invalida un modelo ya aceptado, porque el artefacto no cambia. Sí invalida la ficha de
proveedor y obliga a revalidar la **configuración** antes de producir modelos nuevos con ella.

### 8.2 La ficha del modelo de proveedor

`runs/models/vendors/<proveedor>-<modelo>.json`, generada desde los lotes:
- identificador, versión y fecha de las mediciones;
- rendimiento por condición: aceptación, coste hasta aceptar, sombras y pruebas severas (de SPEC-CONTROL-ARNES);
- variabilidad entre semillas: la banda de los gráficos de control;
- modos de fallo observados: `llm_error`, `diverged`, insubordinación, consumo del presupuesto;
- alternativa probada: otro modelo con su ficha;
- límites conocidos: por ejemplo, ignora observaciones de código o tiende a sombras en cierto tipo de mundo.

## 9. Monitorización tras el uso

Para el arnés, «producción» es usar el modelo aceptado fuera del run que lo produjo:
- **`lab model monitor <id>`** ejecuta el modelo inventariado sobre episodios nuevos de los lugares de su contexto de
  uso, con el mismo objetivo y sin LLM.
- **Resultado:** se apunta en el inventario y entra en el gráfico de control del modelo (SPEC-CONTROL-ARNES §6).
- **Deriva:** una señal de causa especial, o un lugar donde deja de sostenerse, lo pasan a `revalidar`, con aviso en la
  consola.
- **Periodicidad:** la fija el perfil según la criticidad (§10).

## 10. Los dos perfiles

### 10.1 Perfil bancario (SR 11-7 y PRA SS1/23)

**Correspondencia de evidencias**, resumida de memoria y por contrastar con el texto vigente:

| SR 11-7 | evidencia del arnés |
|---|---|
| desarrollo, implementación y uso sólidos | modelo como código, supuestos, contrato del instrumento, reproducción |
| solidez conceptual | §6.2 |
| monitorización continua: verificación del proceso | §6.3 y §9 |
| monitorización continua: benchmarking | §6.5 |
| análisis de resultados y backtesting | §6.4 |
| *effective challenge* | pruebas propias frente a un rival genuino (con la pregunta del Judge sobre muñecos de paja), independencia (§7) |
| inventario | §5 |
| documentación | §6 |
| productos de proveedores | §8.2 |

**SS1/23:** sus cinco principios (identificación y clasificación del riesgo, gobierno, desarrollo y uso, validación
independiente y mitigantes) se cubren con §5, §7, §6, §7 y §6.7, respectivamente. Los mitigantes son los límites de uso
que se derivan del registro de limitaciones.

**Criticidad:** tres clases (alta, media, baja), según la materialidad de la decisión que apoya el modelo y su
complejidad. La revisión periódica es anual para alta y cada dos o tres años para las demás.

### 10.2 Perfil industrial (NASA-STD-7009 y ASME V&V 40)

**NASA-STD-7009** evalúa la credibilidad de un modelo o simulación en varios factores, que recuerdo así: verificación,
validación, pedigrí de las entradas, incertidumbre de los resultados, robustez de los resultados, historial de uso,
gestión del modelo y cualificación de las personas. Correspondencia:

| factor | evidencia del arnés |
|---|---|
| verificación | contrato del instrumento, reproducción (§6.3) |
| validación | checks, familia, confirmación a ciegas, pruebas severas (§6.4, §6.5) |
| pedigrí de las entradas | versión del instrumento, fidelidad a la fuente (I6), informes del instrumento |
| incertidumbre de los resultados | bandas entre semillas, tolerancias, límites de horizonte (caos) |
| robustez de los resultados | variación entre familias y lugares (§6.6) |
| historial de uso | monitorización (§9) |
| gestión del modelo | inventario y cambios (§5, §8) |
| cualificación de las personas | roles (§7); la parte humana la declara el aprobador |

Cada factor se puntúa de 0 a 4. El arnés propone la puntuación con su fuente y el aprobador la firma.

**ASME V&V 40:** la criticidad se deriva del **riesgo del modelo**, que combina la influencia del modelo en la decisión
con la consecuencia de una decisión equivocada. A más riesgo, más evidencia de credibilidad exigida. El inventario
guarda ambos ejes (§5).

## 11. Medidas

- Modelos inventariados por estado y criticidad.
- Proporción con validación vigente.
- Tiempo desde la aceptación hasta la aprobación firmada.
- Limitaciones por modelo y cuántas se cierran.
- Revalidaciones por causa (instrumento, deriva, fecha, contexto).
- Proporción de validaciones independientes.

## 12. Plan

- **M1.** El informe de validación (§6) generado desde lo que ya existe, más el registro de limitaciones. Es lo de más
  valor y no necesita nada nuevo.
- **M2.** Roles e independencia (§7): registrar modelo y proveedor de cada rol en el diario, y la regla de independencia
  en el informe.
- **M3.** Inventario (§5) y `lab model register`.
- **M4.** Ficha de proveedor (§8.2), que depende de las medidas de SPEC-CONTROL-ARNES.
- **M5.** Monitorización (§9) y disparadores de revalidación (§8.1).
- **M6.** Perfiles (§10): la plantilla del informe en las dos estructuras y la puntuación de credibilidad del perfil
  industrial.

**Preguntas abiertas:**
- ¿Dónde firma la persona: en la consola o con `lab model approve`? Propuesta: las dos, con su nombre y fecha en el
  inventario.
- ¿Qué umbral de hallazgos recuperados marca un modelo como «posible sombra» en el registro de limitaciones? Propuesta:
  lo fija el perfil, por ejemplo menos de 0,5 con predicción aceptada.
- ¿Se inventarían modelos de mundos sin verdad (como `tank`)? Propuesta: sí, sin la sección de calificación y con más
  peso en las pruebas severas.
