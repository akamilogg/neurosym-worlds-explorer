# SPEC · Continuidad del contexto: medir lo que se pierde entre rondas

Estado (10/11/2026): **propuesta, sin implementar**. Sale de la lectura de *You don't need long context*
([arXiv:2611.05306](https://arxiv.org/abs/2611.05306)) y del [repaso del repositorio](REPASO-2026-11-10.md) (§2). Añade
instrumentos **del operador** sobre el traspaso entre rondas; no cambia lo que el investigador ve salvo una frase de guía
de método (§6), que es una condición aparte. Se apoya en el cuaderno y `consolidate`
([SPEC-INVESTIGADOR-ASISTIDO](SPEC-INVESTIGADOR-ASISTIDO.md)), en la memoria selectiva (§13 de esa spec), en los cortes y
sondas de la fase A ([SPEC-METAPOLITICA-APRENDIZAJE](SPEC-METAPOLITICA-APRENDIZAJE.md) §6, §8) y en la
[vista de escalada](SPEC-VISTA-ESCALADA.md).

## 1. De dónde sale

El artículo compara tres formas de llevar una tarea larga: acumular toda la historia, compactar al final de cada
conversación y empezar otra, y compactar tras cada acción. Lo que nos concierne:

- **Con un buen traspaso, el rendimiento se mantiene** con contextos mucho más cortos, y el coste por token generado
  baja (estiman entre 3,6 y 7 veces menos al servir con 16K en lugar de 256K).
- **Un traspaso no es un resumen.** Un resumen genérico sobrepondera lo que se repite en la traza y da el mismo peso a
  todo. Su apéndice A dice qué lleva uno bueno: la tarea casi literal, en qué se está y qué se va a hacer, el plan
  descompuesto, cuándo se considera terminada la tarea y referencias a los artefactos.
- **Con un presupuesto fijo, algo se acaba perdiendo.** El remedio que proponen, sin probarlo, es que el arnés guarde
  todos los mensajes y dé una herramienta para leerlos por partes.
- **Los modelos verbosos se hunden con ventanas ajustadas:** un modelo abierto de código pasó del 53 % al 3,6 % porque
  sus trayectorias no dejaban sitio entre compactaciones.
- **Proponen entrenar modelos para esto** (leer un estado en lenguaje natural, dar un paso, reescribir el estado), sin
  llegar a hacerlo.

Lo que el artículo acota: no evalúa subagentes ni recuperación por similitud, y dice expresamente que no descarta tareas
donde el contexto largo ayude. **Se leyó por una herramienta de lectura web:** el texto principal y el apéndice A,
literales; el apéndice G (los prompts de compactación) no se pudo verificar y nada de esta spec depende de él.

El arnés ya hace casi todo lo que el artículo recomienda: rondas que reinician el contexto, un cuaderno que pasa de una a
otra, `consolidate` dentro de la ronda, memoria selectiva sobre el propio diario e instrumentos de observación acotada.
**Lo que no ha hecho nunca es medir si ese traspaso pierde algo.** Y el junior de la fase A, un modelo abierto de 4B, es
el caso en que el artículo vio el hundimiento.

Dos hipótesis se ponen a prueba:

- **H1.** Una instancia nueva que sigue desde el cuaderno decide lo mismo que una que además tiene la ronda anterior
  entera.
- **H2.** Para un modelo dado hay un intervalo de pasos por ronda fuera del cual el progreso por token cae, y ese
  intervalo es más estrecho para el junior que para el modelo fuerte.

## 2. Principios

- **X1. Instrumentos del operador.** Nada de lo que se mide aquí llega a System 2: ni la sonda, ni los contadores
  (sin métrica para System 2).
- **X2. El cuaderno es del investigador.** No se le imponen campos. Lo único que se le puede dar es guía de método,
  genérica y sin ejemplos del entorno, y como condición que se compara con no darla (§6).
- **X3. Se mide con lo que ya pasó.** La sonda se hace sobre cortes de diarios existentes, sin tocar el run del que
  salen y sin actuar sobre ningún mundo.
- **X4. Un dato que falta no es un cero.** Una sonda que no se pudo completar queda sin medir.
- **X5. La conversación sólo crece.** Ninguna medida reescribe ni reordena lo que el investigador recibió.

## 3. La sonda de continuidad

### 3.1 Qué es

En el **corte** entre la ronda *n* y la *n+1* de un diario ya hecho se le pide a una instancia nueva su primera
respuesta de la ronda *n+1*, en dos condiciones:

| Condición | Qué recibe |
|---|---|
| **N · sólo cuaderno** | Exactamente lo que recibió el investigador al empezar la ronda *n+1* |
| **L · cuaderno y ronda** | Lo mismo, precedido de la conversación entera de la ronda *n* |

La respuesta no se ejecuta: se registra y se compara. Cada condición se repite *k* veces (3 por defecto) para separar la
diferencia entre condiciones de la variación del propio modelo.

### 3.2 Qué se compara

El código observa; el juez responde preguntas cerradas, como en la auditoría del método.

- **Por código:**
  - el tipo de acto pedido y su identidad canónica (`act.identity`, donde el laboratorio la da);
  - si el acto repite uno de la ronda *n* (la misma identidad);
  - qué creencias cita y si alguna había caído en la ronda *n*;
  - si pide por memoria selectiva algo que estaba en la ronda *n*.
- **Por el juez,** sobre las dos respuestas, el cuaderno y la **transcripción registrada de la ronda *n*** (lo que el
  investigador vio y escribió en ella, tal como consta en su diario), sin ver el mundo ni la verdad oculta, y con las
  condiciones anonimizadas (no sabe cuál respuesta es N y cuál L):
  - ¿persiguen la misma pregunta?
  - ¿alguna contradice un hecho que la ronda *n* dejó establecido?
  - ¿alguna ignora un plan que el cuaderno declaraba?
- **Por qué la transcripción y no sólo el cuaderno** (revisión externa, 12/11/2026): lo que se quiere medir es justo lo
  que se pierde entre rondas, y un hecho perdido puede faltar del cuaderno. Si el juez sólo viera el cuaderno, no podría
  ver esa pérdida.
- **Cada pérdida que atribuye lleva su cita:** el paso o el pasaje de la transcripción donde quedó establecido el hecho, y
  el de la respuesta que lo contradice o lo ignora. Una pérdida sin cita no cuenta. Prueba: un hecho presente en la
  transcripción y ausente del cuaderno, contradicho por una respuesta, se detecta y se cita.

### 3.3 Qué da

Por corte: la **concordancia** N–L (fracción de pares que piden el mismo experimento), la concordancia L–L y N–N como
suelo de variación, y las **pérdidas** (un hecho contradicho, un experimento repetido, un plan ignorado) atribuidas a
N. H1 se sostiene en un mundo si la concordancia N–L no baja de la L–L más allá de la tolerancia que el operador fije
antes de medir, y las pérdidas de N no superan a las de L.

Formato `continuity-probe@1`: el diario y su hash, el corte, el modelo y su configuración, las respuestas de cada
condición, las observaciones y las respuestas del juez. Un registro que sólo crece, reanudable sin volver a preguntar.

### 3.4 Límites de la sonda

- **Mide la primera decisión, no la trayectoria.** Una pérdida que sólo se nota tres rondas después no aparece.
- **La condición L puede no caber** en la ventana del modelo. Entonces el corte queda sin medir para ese modelo (X4) y se
  dice: es, de paso, un dato sobre el coste del contexto largo.
- **Concordar no es acertar.** Las dos condiciones pueden equivocarse igual.

## 4. El trabajo repetido

Un contador sobre el diario, sin modelo:

- **Actos repetidos entre rondas:** la misma identidad canónica en una ronda posterior, sin que el investigador declare
  que es una réplica (un acto que varía entre ejecuciones, `act.varies`, no cuenta).
- **Lecturas repetidas:** el mismo tramo de un episodio visto otra vez (`view`), o la misma entrada del diario abierta
  otra vez por memoria selectiva.
- **Creencias reabiertas:** una creencia que cayó y vuelve con el mismo enunciado sin evidencia nueva.

Se da por ronda y como fracción del gasto de la ronda. Es la señal barata de las dos patologías que el artículo nombra
(rehacer y releer) y sirve para elegir en qué cortes merece la pena la sonda.

## 5. El contexto vivo

- **Por llamada a System 2:** los tokens de entrada, y de ellos cuántos son prompt común, cuaderno, conversación de la
  ronda y respuestas del mundo. Los da el proveedor donde los da; donde no, se estiman y se dice.
- **Por ronda:** el máximo, cuántas veces se usó `consolidate` y cuánto liberó.
- **En la vista de escalada:** una pista más bajo cada investigador, con el contexto vivo por ronda junto a su progreso.
  Es del operador: no entra en la vista que se exporta para otro agente.

## 6. La guía de método, como condición

Una frase en la guía de método del prompt común, sin ejemplos del entorno:

> Una consolidación es un traspaso para seguir trabajando, no una narración: qué se intenta resolver, qué quedó
> establecido, qué se iba a hacer después y qué haría falta para darlo por terminado.

Va detrás de una opción (`--handoff-guidance`), apagada por defecto, para que los prompts de todas las configuraciones
existentes no cambien. Se evalúa como cualquier guía: con y sin ella, a igual presupuesto, por la sonda (§3), el trabajo
repetido (§4) y el resultado del run.

## 7. El junior

- **Barrido en la línea base de la fase A.** Los pasos por ronda y el uso de `consolidate` dejan de ser un valor fijo: la
  línea base se lanza con al menos tres valores de pasos por ronda. Se lee el progreso por token y el trabajo repetido
  en cada uno (H2).
- **El traspaso como competencia.** Un peldaño más de la escalera, medido por sondas como los otros: dado un corte, el
  junior escribe su cuaderno; otra instancia del junior sigue desde él; la sonda de §3 dice cuánto concuerda con seguir
  desde la ronda entera. Es lo que el artículo propone entrenar y no entrena.
- **Como objetivo de destilación,** sólo si el peldaño muestra un déficit: los cuadernos del modelo fuerte en esos
  cortes son ejemplos, con su procedencia declarada como toda ayuda ajena.

Las dos últimas dependen de que la línea base exista; no se construyen antes.

## 8. Entregas

| Etapa | Depende de | Entrega |
|---|---|---|
| **CX1 · Trabajo repetido y contexto vivo** | — | Los contadores de §4 y §5 sobre diarios existentes (`lab continuity <run>`), sin modelo; la pista en la vista de escalada |
| **CX2 · La sonda** | CX1 | `continuity-probe@1`: cortes, condiciones N y L, observaciones por código, preguntas del juez, reanudación; `lab continuity probe <run> --cuts …` |
| **CX3 · La guía** | CX2 | `--handoff-guidance` y su comparación en un lote |
| **CX4 · El junior** | CX2, línea base de la fase A | El barrido de pasos por ronda; el peldaño de traspaso con sus sondas |

**CX1 y CX2 se pueden medir ya sobre los diarios de la cuadrícula, de `particles3d` y de 3SUM,** sin la máquina de las
GPU. CX1 no gasta nada; CX2 gasta dos respuestas por repetición y corte, más las del juez.

## 9. Aceptación

1. Los contadores de CX1 dan lo mismo dos veces sobre el mismo diario y no llaman a ningún modelo.
2. Un acto repetido con otro orden de claves o con los valores por defecto escritos cuenta como el mismo; uno que el
   laboratorio declara variable no cuenta como repetido.
3. La condición N de la sonda recibe byte a byte lo que el investigador recibió al empezar esa ronda.
4. La sonda no escribe en el diario del que lee ni actúa sobre ningún mundo.
5. Una sonda interrumpida se reanuda sin volver a preguntar lo ya respondido.
6. Un corte cuya condición L no cabe en la ventana queda sin medir, con su motivo, y no cuenta en la concordancia.
7. Con `--handoff-guidance` apagado, los prompts de todos los mundos son idénticos a los de antes.
8. Nada de CX1 ni de CX2 aparece en lo que recibe System 2 ni en la vista del investigador de un hallazgo.

## 10. Límites

- **La evidencia de partida es un solo artículo,** leído en parte y sobre tareas de programación, no de investigación.
- **La sonda es cara donde más interesa:** la condición L es justo el contexto largo que se quiere evitar.
- **El juez de la sonda necesita calibrarse** contra una persona, como el de la auditoría; hasta entonces sólo se leen
  las observaciones por código.
- **Si H1 se sostiene, no se sigue que el cuaderno sea óptimo:** sólo que no pierde frente a la ronda anterior. Si no se
  sostiene, la sonda dice dónde se pierde, no cómo arreglarlo.
