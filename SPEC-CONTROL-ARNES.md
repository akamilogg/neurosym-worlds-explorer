# SPEC · El arnés como proceso controlado: rendimiento, observabilidad y control estadístico

Estado: propuesta (07/10/2026). Nada implementado. Mide lo que SPEC-RIESGO-MODELOS necesita para la ficha del modelo de
proveedor y la monitorización.

## 1. De dónde sale

### 1.1 La idea que guía el proyecto

En palabras del autor (07/10/2026): **un sistema que a nuestro entender es estocástico, con suficientes mecanismos de
control, puede convertirse en un sistema predecible a efectos prácticos.** Su esfuerzo se convierte en trabajo útil con
un grado de eficiencia predecible.

Lo compara con un motor de combustión. Nadie modela con exactitud la dinámica de fluidos de la combustión, ni el motor
entero, y aun así el motor convierte de forma predecible una parte de la energía en trabajo útil. El resto se pierde, y
también eso es predecible.

En el arnés, el LLM es la combustión: estocástico, y su razonamiento no se modela. Los controles (checks, validación,
confirmación a ciegas, directivas del senior, pruebas propias, contrato del instrumento) son los que convierten ese
esfuerzo en modelos aceptados. Esta spec mide esa conversión.

### 1.2 La tradición en la que se inscribe

| quién | idea | en el arnés |
|---|---|---|
| **Black, 1927**, el amplificador con realimentación negativa | componentes imprecisos más realimentación dan un amplificador exacto; se cambia ganancia por precisión | un LLM impreciso con checks y rondas da un modelo exacto en lo que se comprueba; se cambian tokens por fiabilidad |
| **Shannon, 1948**, la codificación de canal | sobre un canal con ruido se transmite con error tan pequeño como se quiera, si la tasa no pasa de la capacidad | hay un rendimiento máximo (modelos correctos por token) que ningún control supera; la eficiencia es la fracción alcanzada |
| **Von Neumann, 1956**, sistemas fiables con piezas no fiables | redundancia y votación | semillas, réplicas, junior y senior, confirmación a ciegas en varios conjuntos |
| **Carnot** | todo motor tiene un rendimiento máximo | ningún arnés convierte todo su gasto en conocimiento: las pérdidas son estructurales |
| **Shewhart y Deming**, control estadístico de procesos | separar la variación por causa común (ruido inevitable) de la causa especial (algo que se rompió) | gráficos de control sobre los runs (§6) |
| **Ashby**, la variedad requerida | el controlador necesita al menos tanta variedad como las perturbaciones | diseño de lotes que cubra las perturbaciones (§7) |
| **Kalman**, la observabilidad | sólo se controla lo que los sensores distinguen | la matriz de observabilidad (§5) |

### 1.3 Lo que añadieron los experimentos: controlar hacia lo equivocado

El modelo-sombra de `c302nav` fue un **sistema perfectamente controlado hacia el objetivo equivocado**. Los controles
funcionaron: llevaron al investigador, de forma predecible, a un modelo que predice las señales. Pero la señal de
control, la R² en la familia, no distinguía el mecanismo de su sombra. El control fue eficaz y el resultado,
predeciblemente incorrecto.

Es un fallo de **observabilidad**, no de control. Las pruebas propias con intervención no son un control más: **son un
sensor nuevo**, que hace observable lo que el check no veía. El instrumento que miente es el mismo problema en el otro
extremo: un control estadístico sobre un sensor falso controla con precisión una mentira.

La tesis completa, reformulada: **un sistema estocástico se vuelve predecible en la medida en que sus controles observan
lo que importa, con una eficiencia acotada por la capacidad del canal entre el sistema y sus sensores.**

## 2. Qué no promete

- **No estima la capacidad teórica.** El rendimiento máximo del canal entre el LLM y el mundo no se puede calcular. Se
  usa como referencia la **frontera observada**: el mejor rendimiento medido entre condiciones comparables.
- **Los gráficos de control piden datos.** Un run cuesta minutos u horas y dólares, así que las series serán cortas. Los
  límites se calculan con lo que haya y se marcan como provisionales hasta tener una base suficiente (§6.2).
- **Medir el rendimiento no lo mejora.** Sirve para detectar regresiones, comparar configuraciones y caracterizar un
  modelo de proveedor.

## 3. El arnés como planta controlada

| pieza del lazo | en el arnés |
|---|---|
| **planta** | el LLM investigador con su memoria |
| **consigna** | la tarea y la faceta, y lo que cuenta para aceptar |
| **sensores** | el check, la familia de validación, la confirmación a ciegas, las pruebas propias, el contrato del instrumento, el calificador y la auditoría (estos dos sólo para el operador) |
| **actuadores** | las respuestas del entorno (veredictos), la devolución de una propuesta con una orden abierta, las directivas y la hipótesis inicial del senior, los presupuestos |
| **salida útil** | un modelo aceptado que es correcto |
| **pérdidas** | rondas sin progreso, tokens, sombras aceptadas, propuestas devueltas, simulaciones rechazadas |

## 4. Magnitudes de rendimiento

Calculadas por run desde el diario, el finding y la auditoría, y agregadas por condición en el informe del lote:

- **E1. Rendimiento:** aceptaciones correctas por millón de tokens, junior y senior sumados. Una aceptación es
  **correcta** si:
  - en mundos con verdad, su calificación supera el umbral del perfil;
  - en mundos sin verdad, el modelo final superó al menos una prueba severa prerregistrada.

  Se da también en dólares, con el coste del proveedor.
- **E2. Tasa de sombras:** aceptaciones no correctas entre las aceptaciones. Es la aceptación falsa del lazo.
- **E3. Rechazo falso:** runs sin aceptar cuyo mejor modelo era correcto según la calificación. Sólo en mundos con
  verdad.
- **E4. Pérdidas por fase:**
  - rondas hasta el primer modelo que se sostiene;
  - rondas tras la última orden del senior hasta aplicarla;
  - propuestas devueltas;
  - pasos de investigación sin experimento (sólo mirar).
- **E5. Rendimiento del control del senior:** órdenes que acaban en el modelo (su adopción), coste por orden adoptada y
  efecto de la hipótesis inicial en las rondas hasta el primer modelo que se sostiene.
- **E6. Eficiencia relativa:** E1 de la condición dividido por la frontera observada (el mejor E1 medido en el mismo
  mundo y con la misma consigna).

## 5. La matriz de observabilidad

Para cada modo de fallo conocido, qué sensor lo distingue. Una celda vacía es un fallo que el lazo no puede corregir,
porque no lo ve.

| modo de fallo | check | familia y ciegas | pruebas propias | contrato del instrumento | informes del instrumento | calificador o auditoría (sólo operador) |
|---|---|---|---|---|---|---|
| no predice | sí | sí | sí | — | — | sí |
| sobreajuste al laboratorio | parcial | sí | sí | — | — | sí |
| **sombra del mecanismo** | **no** | **no** | **sí, si el rival es genuino** | — | — | sí |
| instrumento que miente | no | no | no | sí (lo previsto) | sí (lo imprevisto) | parcial |
| insubordinación del junior | — | — | — | — | — | la ven el senior y la auditoría |
| derroche de presupuesto | — | — | — | — | — | E4 |

La matriz se mantiene a mano en esta spec y se revisa cada vez que aparece un modo de fallo nuevo. Cada fila sin sensor
del investigador es candidata a una spec nueva, como lo fueron las pruebas propias y la calibración.

## 6. Gráficos de control

### 6.1 Qué se grafica

- **Por condición, run a run:** E1, E2 (como proporción) y el coste hasta aceptar. Gráfico de valores individuales con
  rango móvil, y gráfico de proporción para E2.
- **Por modelo de proveedor:** las mismas series, que forman la ficha de SPEC-RIESGO-MODELOS §8.2.
- **Por modelo inventariado:** su resultado en cada monitorización (SPEC-RIESGO-MODELOS §9).

### 6.2 Límites y señales

- **Base:** los primeros 8 runs de una condición con la misma versión del código y del modelo. Por debajo de 8, los
  límites son provisionales.
- **Límites:** la media más o menos tres sigmas estimadas del rango móvil.
- **Señales de causa especial** (reglas de Western Electric): un punto fuera de los límites, 2 de 3 consecutivos más allá
  de dos sigmas en el mismo lado, u 8 consecutivos al mismo lado de la media.
- **Cada señal se anota con la causa probable:** se comparan el commit, la versión del instrumento, el modelo y el
  proveedor del punto con los de la base. Si nada cambió, la causa es desconocida y se avisa.
- **Al cambiar de versión, la base se recalcula,** y el gráfico marca la frontera entre versiones.

### 6.3 Dónde se ve

En el informe del lote (una línea por condición: en control o con señales) y en la consola (el gráfico por condición,
con las versiones marcadas).

## 7. Variedad requerida: diseñar lotes que cubran las perturbaciones

Un lazo validado sólo con una semilla y un mundo no está caracterizado. Perturbaciones que un lote debe cubrir para dar
la ficha de un modelo de proveedor:
- semillas (al menos 3);
- familias o lugares del mundo;
- nombres reales frente a neutros, donde aplica;
- con y sin senior, y con y sin hipótesis inicial;
- presupuestos.

`lab batch` puede generar el diseño desde una plantilla (`"vary": {...}`) y avisa de las perturbaciones que el lote deja
sin cubrir.

## 8. Medidas

- E1 a E6 por condición, con su banda.
- Condiciones en control y con señales.
- Filas de la matriz de observabilidad sin sensor del investigador.
- Cobertura de perturbaciones de cada ficha de proveedor.

## 9. Plan

- **K1.** E1 a E4 en el finding y en el informe del lote, desde lo que ya se registra. E2 y E3 necesitan calificación
  donde hay verdad.
- **K2.** E5: la adopción de órdenes, que ya figuraba como pendiente en SPEC-ORQUESTADOR §3.3.3.
- **K3.** Los gráficos de control (§6) en el informe del lote y en la consola, con las reglas y la anotación de causas.
- **K4.** La plantilla de variación de lotes (§7) y el aviso de cobertura.
- **K5.** E6 y la frontera observada, cuando haya varias condiciones comparables por mundo.

**Preguntas abiertas:**
- ¿Qué umbral de calificación hace correcta una aceptación (E1)? Propuesta: lo fija el perfil de SPEC-RIESGO-MODELOS;
  provisionalmente, 0,5 de hallazgos recuperados.
- ¿Ocho runs de base son asumibles en `c302nav`, donde un run cuesta horas? Propuesta: en mundos caros, la base empieza
  en 5 con límites provisionales, y se completan con mundos baratos (`cells`, `tank`) para la ficha del proveedor.
