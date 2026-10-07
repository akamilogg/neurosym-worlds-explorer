# SPEC · El arnés como proceso controlado: resultados, coste, observabilidad y estabilidad

Estado: propuesta (07/10/2026), revisada con una auditoría externa el mismo día (§10). Nada implementado. Mide lo que
SPEC-RIESGO-MODELOS necesita para caracterizar la configuración generadora y para las estadísticas de robustez del
informe de validación.

## 1. De dónde sale

### 1.1 La idea que guía el proyecto

En palabras del autor (07/10/2026): **un sistema que a nuestro entender es estocástico, con suficientes mecanismos de
control, puede convertirse en un sistema predecible a efectos prácticos.** Su esfuerzo se convierte en trabajo útil con
un grado de eficiencia predecible.

Lo compara con un motor de combustión. Nadie modela con exactitud la dinámica de fluidos de la combustión, ni el motor
entero, y aun así el motor convierte de forma predecible una parte de la energía en trabajo útil.

En el arnés, el LLM es la combustión: estocástico, y su razonamiento no se modela. Los controles (checks, validación,
confirmación a ciegas, directivas del senior, pruebas propias, contrato del instrumento) son los que convierten ese
esfuerzo en modelos aceptados.

**Esta spec trata la idea como hipótesis por comprobar, no como un hecho del arnés.** Que el proceso sea predecible de
un run a otro es justo lo que hay que medir (§6).

### 1.2 Analogías, no límites demostrados

La idea pertenece a una tradición de la ingeniería. Estas correspondencias son **analogías** que orientan el diseño.
No son límites demostrados del arnés: nadie ha calculado una capacidad de canal ni un rendimiento máximo para un LLM que
investiga.

| quién | idea | analogía en el arnés |
|---|---|---|
| **Black, 1927**, realimentación negativa | componentes imprecisos más realimentación dan un amplificador exacto | un LLM impreciso con checks y rondas puede dar un modelo exacto en lo que se comprueba |
| **Shannon, 1948**, codificación de canal | sobre un canal con ruido se transmite con error tan pequeño como se quiera, por debajo de la capacidad | quizá haya un rendimiento máximo que ningún control supere; aquí no se estima |
| **Von Neumann, 1956**, fiabilidad con piezas no fiables | redundancia y votación | semillas, réplicas, junior y senior, varios conjuntos ciegos |
| **Carnot** | todo motor tiene un rendimiento máximo | las pérdidas parecen estructurales; no se sabe cuánto |
| **Shewhart y Deming**, control estadístico de procesos | separar la variación por causa común de la causa especial | aspiración para cuando haya datos comparables suficientes (§6.3) |
| **Ashby**, variedad requerida | el controlador necesita tanta variedad como las perturbaciones | diseño de lotes que cubra las perturbaciones (§7) |
| **Kalman**, observabilidad | sólo se controla lo que los sensores distinguen | la matriz de observabilidad (§5) |

### 1.3 Lo que los experimentos muestran, y lo que todavía no

- **Muestran una discrepancia entre el objetivo predictivo y la ambición mecanística.** En `c302nav`, los controles
  llevaron al investigador a un modelo que predice las señales: pasa el check, la familia y la confirmación a ciegas.
  Ese modelo recupera 0,11 de los hallazgos del mecanismo. La señal de control (la R² en la familia) no distinguía un
  modelo fenomenológico de uno mecanístico. Las pruebas propias con intervención funcionan como un **sensor nuevo**, que
  hace observable esa diferencia.
- **Todavía no muestran que el proceso sea predecible de un run a otro.** Hay pocos runs comparables por condición.
  Medirlo es el objeto de esta spec.

La tesis, como hipótesis de trabajo: *un proceso estocástico puede volverse predecible en la medida en que sus controles
observan lo que importa para el uso declarado*.

## 2. Qué no promete

- **No estima una capacidad teórica.** Como referencia sólo se usa la **frontera observada**: el mejor resultado medido
  entre condiciones comparables, con su incertidumbre.
- **No etiqueta un proceso como «en control» sin datos que lo sostengan.** Con pocos runs da estadística descriptiva e
  intervalos (§6).
- **No mide actividad como si fuera utilidad.** Mirar, rechazar una orden con razón o aceptar una que empeora el modelo
  no son buenos ni malos por sí mismos (§4.3).

## 3. El arnés como planta controlada

| pieza del lazo | en el arnés |
|---|---|
| **planta** | el LLM investigador con su memoria |
| **consigna** | la tarea, la faceta y los criterios declarados del uso |
| **sensores** | el check, la familia de validación, la confirmación a ciegas, las pruebas propias, el contrato del instrumento, el calificador y la auditoría (estos dos sólo para el operador) |
| **actuadores** | los veredictos del entorno, la devolución de propuestas, las directivas y la hipótesis inicial del senior, los presupuestos |
| **salida** | un modelo aceptado, con los resultados de §4.1 |

## 4. Resultados y coste

### 4.1 Resultados de un run, cada uno por separado

Con los mismos nombres que el informe de validación (SPEC-RIESGO-MODELOS R6):
- **O1. Aceptación predictiva:** sí o no.
- **O2. Evidencia discriminante prerregistrada:** número de pruebas severas superadas como prerregistradas por el
  modelo final, con la respuesta del Judge sobre si cada rival era genuino.
- **O3. Adecuación al contexto de uso:** sí, no o no evaluable, según criterios declarados **antes** del lote.
- **O4. Recuperación mecanística**, donde hay verdad: la calificación del modelo final, con la versión del calificador.
  Es continua: no se convierte en «falso» por debajo de un umbral.

Ninguno se llama «correcto». La **discrepancia entre predicción y mecanismo** (O1 sí con O4 baja) se informa como un
hecho descriptivo, no como aceptación falsa.

### 4.2 Coste y eficiencia

- **Coste total** de una condición: la suma de **todas** sus ejecuciones, incluidos los runs que no aceptan, el senior,
  la auditoría y los experimentos. Se da por separado en **tokens, dinero y tiempo de reloj**.
- **Eficiencia bajo un criterio declarado:** runs que cumplen ese criterio (por ejemplo O1, u O1 y O3) divididos por el
  coste total. Siempre se dice qué criterio es.

### 4.3 Trazas del proceso, sin valoración

Se informan como descripción del proceso, nunca como «pérdidas» o «rendimiento»:
- rondas hasta el primer modelo que se sostiene;
- pasos de investigación por tipo (mirar, experimentar, recordar);
- propuestas devueltas;
- órdenes del senior y lo que el junior hizo con ellas: aplicarlas, discrepar, rechazarlas con razón.

El **efecto** del senior o de su hipótesis inicial sólo se atribuye mediante **comparaciones controladas**: lotes
emparejados con y sin senior, y con y sin apertura, con las mismas semillas, versión y presupuesto. Contar órdenes
adoptadas no basta: una orden adoptada puede empeorar el modelo.

## 5. La matriz de observabilidad

Para cada modo de fallo conocido, qué sensor lo distingue. Una celda vacía es un fallo que el lazo no puede corregir,
porque no lo ve.

| modo de fallo | check | familia y ciegas | pruebas propias | contrato del instrumento | informes del instrumento | calificador o auditoría (sólo operador) |
|---|---|---|---|---|---|---|
| no predice | sí | sí | sí | — | — | sí |
| sobreajuste al laboratorio | parcial | sí | sí | — | — | sí |
| **modelo fenomenológico donde el uso pide mecanismo** | **no** | **no** | **sí, si el rival es genuino y la prueba interviene** | — | — | sí |
| instrumento que miente | no | no | no | sí (lo previsto) | sí (lo imprevisto) | parcial |
| el junior ignora las órdenes | — | — | — | — | — | la ven el senior y la auditoría |
| consumo del presupuesto sin avance | — | — | — | — | — | trazas de §4.3 |

La matriz se revisa cada vez que aparece un modo de fallo nuevo. Cada fila sin sensor del investigador es candidata a
una spec nueva, como lo fueron las pruebas propias y la calibración.

## 6. Estabilidad entre runs

### 6.1 Grupos comparables

Un **grupo** es un conjunto de runs comparables: misma condición del lote, mismo mundo y familia, misma versión del
código y del instrumento, misma configuración generadora y mismos criterios. Sólo se agregan runs del mismo grupo.

**Poblaciones distintas no se mezclan.** Los runs baratos de `cells` amplían la caracterización de un proveedor, pero
no completan la base de `c302nav`: son otra población, y se informan por separado.

### 6.2 Lo que se informa con pocos runs

Cada resultado y coste por grupo, como estadística descriptiva con su incertidumbre:
- **proporciones** (O1, O3): el recuento y el intervalo de Wilson, con el tamaño del grupo;
- **recuentos y valores continuos** (O2, O4, coste): mediana, cuartiles e intervalo por bootstrap;
- **ningún rótulo de «en control»** ni de «fuera de control».

Un run aporta **una** observación binaria de O1. Una proporción sólo existe sobre un grupo de tamaño declarado.

### 6.3 Control estadístico, cuando los datos lo permitan

Sólo cuando un grupo acumule suficientes runs comparables. Antes de usar un gráfico de control se comprueban sus
supuestos (según el manual de ingeniería estadística del NIST para gráficos de proporciones): probabilidad estable,
independencia entre runs y grupos de tamaño definido. Aun entonces, las señales se presentan como **indicios de causa
especial que hay que investigar**, no como diagnóstico.

### 6.4 Referencias congeladas

- **Una referencia** es la distribución de un grupo en una versión dada, congelada con el hash de sus runs.
- **Al cambiar de versión, no se borra la referencia anterior.** Primero se compara la versión nueva contra ella con la
  misma estadística de §6.2, para ver si empeora, mejora o no se distingue. Sólo después una persona decide establecer
  una referencia nueva.
- Así un cambio que empeora el proceso no se normaliza en silencio.

## 7. Variedad requerida: diseñar lotes que cubran las perturbaciones

Una configuración caracterizada con una semilla y un mundo no está caracterizada. Perturbaciones que debe cubrir un lote
de caracterización:
- semillas (al menos 3 por grupo);
- familias o lugares del mundo;
- nombres reales frente a neutros, donde aplica;
- con y sin senior, y con y sin hipótesis inicial: las comparaciones controladas de §4.3;
- presupuestos.

`lab batch` puede generar el diseño desde una plantilla (`"vary": {...}`) y avisa de las perturbaciones que el lote deja
sin cubrir.

## 8. Medidas

- O1 a O4 y el coste total por grupo, con su incertidumbre.
- Eficiencia bajo cada criterio declarado.
- Efectos del senior y de la apertura, sólo desde comparaciones controladas.
- Filas de la matriz de observabilidad sin sensor del investigador.
- Cobertura de perturbaciones de cada caracterización.

## 9. Plan

En el orden que propone la auditoría:
- **K1. Resultados separados y coste total** (§4.1, §4.2) en el finding y el informe del lote, con criterios declarados
  y estadística descriptiva con incertidumbre (§6.2).
- **K2. Grupos comparables y referencias congeladas** (§6.1, §6.4): agrupar por versión, configuración y criterios;
  comparar cada versión nueva contra la referencia anterior.
- **K3. Comparaciones controladas** para el senior y la apertura (§4.3, §7): la plantilla de variación de lotes con
  emparejamiento.
- **K4. Trazas del proceso** (§4.3), sin valoración.
- **K5. Control estadístico** (§6.3), sólo en grupos que acumulen datos comparables y cumplan sus supuestos.

**Preguntas abiertas:**
- ¿Qué criterios de adecuación (O3) se declaran para `c302nav`? Propuesta: dos usos, «anticipar las señales» (sólo O1)
  y «diseñar intervenciones» (O1 más pruebas severas con intervención). Cada uno da su propia eficiencia.
- ¿Cuántos runs comparables hacen falta antes de §6.3? Depende de la variabilidad observada. Con 5 u 8 runs, sólo §6.2.

## 10. Auditoría externa (07/10/2026): qué cambió

- **E1 ya no llama «correcto» a lo que sólo tiene evidencia favorable.** Los resultados se separan en aceptación
  predictiva, evidencia discriminante prerregistrada, adecuación a un uso con criterios declarados y recuperación
  mecanística (§4.1).
  - Una prueba severa superada no demuestra corrección general.
  - Una recuperación baja no hace falsa una aceptación.
  - Desaparece la «tasa de sombras» como aceptación falsa.
- **Eficiencia** = runs que cumplen un criterio declarado entre el coste total de todas las ejecuciones, incluidos los
  fallos, el senior y los experimentos, en tokens, dinero y tiempo por separado (§4.2).
- **Actividad no es utilidad.**
  - Mirar, órdenes adoptadas o rechazadas: se informan como trazas, sin valoración (§4.3).
  - El efecto del senior y de la apertura sólo se atribuye con comparaciones controladas.
- **Estadística honesta:**
  - Grupos comparables definidos, sin mezclar poblaciones (`cells` no completa la base de `c302nav`).
  - Estadística descriptiva con intervalos para pocos runs, sin rótulo de «en control».
  - Supuestos del NIST antes de un gráfico de control.
  - Referencias congeladas: la nueva versión se compara con la anterior antes de sustituirla (§6).
- **Las referencias teóricas** (Shannon, Carnot, Kalman) se presentan como analogías, no como límites del arnés. La tesis
  es una hipótesis por comprobar: `c302nav` muestra una discrepancia entre predicción y mecanismo, no la
  predictibilidad del proceso (§1.2, §1.3).
- **El plan se reordena:** primero resultados, coste y estadística descriptiva; el control estadístico, al final.
