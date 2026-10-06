# SPEC · `c302nav` en lazo cerrado: un gusano que se mueve en un campo de olor

Estado: propuesta (06/10/2026), revisada con una auditoría externa el mismo día (§13). Nada implementado. Se avanza
con L0 y L1; antes de lanzar investigadores deben estar cerrados los tres contratos de §5, §6 y §7.

## 1. De dónde sale

`c302-navigation@1` (SPEC-EUREKA-NAVEGACION) es un mundo en **lazo abierto**. Se inyecta una corriente en AWCL y AWCR,
se simula el panel de 28 células de c302 y se leen dos señales: la reorientación y el giro. Nada se mueve. Varios
*insights* de la rúbrica de `navigation-goals` no se pueden **investigar** en él:

| insights | de qué tratan | por qué no en lazo abierto |
|---|---|---|
| I3, I5, I7, I9, I12 | cómo el mecanismo lleva al gusano hacia el olor, cómo acaba orientado tras una racha | no hay cuerpo, ni movimiento, ni gradiente |
| I18 (*limitation*) | si las acciones influyen sobre el estado que persiste | las acciones no realimentan nada |
| I17 (*limitation*) | cómo se desplaza la ocupación de los regímenes en un run largo | 9 s es poco |

**La idea:** el mismo c302, pero sus dos señales mueven un gusano virtual en un campo de olor, y la corriente en AWC sale
de lo que huele el gusano donde está.

**Qué no promete.** El lazo cerrado hace estos fenómenos **investigables**, no garantiza que aparezcan ni que una
intervención identifique su causa. Puede haber deriva en la ocupación de los regímenes o no haberla, y el circuito
puede llevar al cuerpo a un régimen poco informativo. Que los estímulos naturales sean más discriminantes que los
trenes de pulsos es una hipótesis, que L3 comprobará.

## 2. Principios

- **C1. Otro mundo, el mismo arnés.** Es una variante de laboratorio (`c302-navigation-closed@1`) con la interfaz de
  siempre. El arnés no se adapta a él.
- **C2. El cuerpo y el sensor son nuestros:** se documentan y se **verifican** por sí mismos (L1, §8), antes de
  atribuir nada al circuito.
- **C3. El circuito es el mismo:** el panel de c302, nivel C1, con las mismas intervenciones y la misma lectura de las
  señales (el doble filtro de 200 ms).
- **C4. Fidelidad con tolerancias declaradas** antes de investigar (§4).
- **C5. El investigador no recibe ninguna estrategia de navegación.**
- **C6. Dos lecturas separadas:** lo que se comprueba en **este** mundo, y su correspondencia con EurekaBench (§11).

## 3. El problema técnico: simular paso a paso

En lazo cerrado, la corriente en el instante t depende de la posición del gusano, que depende de las señales
anteriores. El ejecutor actual (jNeuroML) simula los 9 s de una vez con los estímulos fijados de antemano.
Comprobado el 06/10/2026: en el entorno de EurekaBench hay jNeuroML y pyLEMS, pero no NEURON.

- **Motor:** NEURON. NeuroML documenta la exportación a NEURON, y NEURON admite corrientes que cambian durante la
  simulación (`IClamp`, que se cambia paso a paso). Se descartan las otras dos vías: simular por bloques necesita
  guardar el estado completo de la red, y repetir la simulación hasta que converja costaría cientos de simulaciones
  por run.
- **El lazo corre dentro del servicio:** `POST /closed-loop` simula un episodio entero en una sola petición, con su
  clave de idempotencia y su reproducción. Es genérico de c302: la red, las intervenciones, el cuerpo y el campo son
  parámetros de la petición.
- **Lectura incremental:** el servicio calcula las señales paso a paso, conservando el **estado de los dos filtros**
  entre pasos, y debe reproducir exactamente la lectura de `c302nav`.

## 4. Fidelidad (L0)

Antes de cualquier run, NEURON frente a jNeuroML en lazo abierto, con **tolerancias declaradas**, no "el mismo calcio":
- **Trazas:** el error relativo máximo del calcio en las células de lectura, con una tolerancia que se fija y se
  justifica en L0.
- **Señales:** la R² de las dos señales de NEURON frente a las de jNeuroML, mayor que un umbral (por ejemplo 0,99).
- **Tiempos de transición:** el instante del primer salto del calcio tras un pulso (el suceso por umbral que vimos),
  con una diferencia máxima en milisegundos.
- **Casos:** los 10 protocolos de N0, más intervenciones representativas (cortar una conexión, escalar otra, cambiar un
  parámetro) y el caso de calibración de I3b de SPEC-ANOMALIAS-INSTRUMENTO.
- **Pasos:** varios pasos de integración neuronal (0,05 y 0,025 ms) y de control (5 y 2,5 ms). Las señales no deben
  depender del paso de control más allá de la tolerancia.
- **Lectura incremental:** las señales calculadas paso a paso coinciden con las calculadas sobre la traza completa.

Si la fidelidad falla, la spec se replantea.

## 5. Contrato 1: el orden temporal de cada paso

Cada paso de control k, de duración Δ (5 ms), sigue este orden fijo:
1. **Observación:** el estado en t_k: posición, rumbo y concentración en la nariz en t_k, y la corriente que se aplicó
   en (t_{k−1}, t_k].
2. **Corriente:** la corriente de AWC para (t_k, t_{k+1}] se calcula a partir de la concentración en t_k.
3. **Avance neuronal:** NEURON integra la red de t_k a t_{k+1}.
4. **Lectura:** las señales en t_{k+1} salen del calcio en t_{k+1}, pasando por los filtros con su estado.
5. **Movimiento:** el cuerpo se mueve de t_{k+1} a t_{k+2} según las señales en t_{k+1}.

**Las señales en t no se revelan a través del movimiento.** El rumbo en t refleja señales anteriores a t, y como las
señales son lentas (filtradas a 200 ms), la variación reciente del rumbo casi las revela. Por eso:
- **La faceta de señales** recibe sólo los estímulos y las intervenciones: el mismo percepto que `c302nav`, sin
  posición ni rumbo. Así es comparable con el laboratorio abierto y no puede reconstruir la acción observada.
- **La faceta de navegación** recibe el estado del cuerpo, pero lo que predice es el **futuro** del cuerpo (§7), no las
  señales.

## 6. Contrato 2: el azar

Un cuerpo que sortea los giros bruscos no es predecible punto a punto, aunque se conozca perfectamente la ley:
reproducible con una semilla no significa predecible para el investigador. El orden:
- **Primero, una condición determinista** (`--body deterministic`): el giro brusco ocurre cuando la tasa acumulada de
  reorientación cruza un umbral, y el ángulo sale de una regla fija. Es el cuerpo de L1 y del primer run. En él, una
  predicción puntual es justa.
- **Después, la condición aleatoria** (`--body stochastic`), con un objetivo que admita incertidumbre:
  - el modelo predice **probabilidades** de suceso (por ejemplo, un giro brusco en los próximos 500 ms) o
    distribuciones del rumbo;
  - se evalúan con una puntuación propia (Brier o log-verosimilitud) frente a lo que ocurrió;
  - o como estadísticas sobre **réplicas**: el mismo episodio con varias semillas.

  Nunca una trayectoria puntual frente a un único resultado aleatorio.

## 7. Contrato 3: la evaluación de la navegación

Predecir el paso siguiente no obliga a entender el lazo: con velocidad constante y pasos de 5 ms, extrapolar la
posición y el rumbo funciona casi siempre. La faceta de navegación se evalúa así:
- **Varios horizontes,** usando las propias predicciones del modelo (*rollout*): a 50 ms, 500 ms y 2 s. El modelo
  simula el lazo con su propia explicación, sin ver el cuerpo real en los pasos intermedios.
- **Medidas alrededor de las reorientaciones:** acertar si ocurre un giro brusco, cuándo, y cuál es el rumbo resultante
  respecto a la fuente.
- **Referencias que no saben nada,** frente a las que debe ganar en todos los horizontes:
  - «sigue recto»;
  - «mantén la velocidad angular reciente»;
  - «gira al azar con la tasa media».
- **Predicciones bajo intervención:** cómo cambia la navegación al cortar una conexión, cambiar un parámetro o mover la
  fuente. Encaja con las pruebas propias (SPEC-PRUEBAS-PROPIAS), cuyo protocolo es un `act` de este mundo.

La faceta de señales conserva el objetivo de `c302nav`: R² con los casos degenerados de SPEC-PRUEBAS-PROPIAS §4.1.

## 8. El cuerpo y el campo (L1): funciones concretas y verificación

### 8.1 Funciones fijadas antes de investigar

- **El campo:** una fuente puntual, con una concentración que decae con la distancia (forma y pendiente, parámetros del
  lugar). Arena acotada y **paredes que reflejan**.
- **Oler:**
  - la nariz va en la punta de la cabeza, que oscila con una frecuencia y una amplitud fijas;
  - el total de la corriente en AWC es una función creciente y **saturante** de la concentración, en el rango de 2,5 a
    6 pA;
  - el reparto entre los dos lados sigue la fase de la oscilación;
  - sin adaptación en el sensor (§12).
- **Actuar:**
  - la reorientación, que puede ser negativa, se transforma en una **tasa no negativa** con una función declarada (por
    ejemplo, `tasa = g · max(0, r − r0)`, con saturación);
  - la tasa da la probabilidad por paso, `1 − exp(−tasa · Δ)`, en la condición aleatoria, o se acumula hasta un umbral
    en la determinista;
  - el giro dobla el rumbo con una ganancia y una velocidad angular máxima declaradas;
  - la velocidad es constante.
- **Llegada:** el episodio termina al entrar en un radio de la fuente, o por tiempo.

### 8.2 Verificaciones del cuerpo por sí mismo

Antes de atribuir nada al circuito, con "circuitos" sintéticos en lugar de c302:
- **Campo uniforme:** el reparto entre los dos lados oscila aunque la concentración sea la misma en todas partes, así
  que se **mide si produce una deriva** sistemática del rumbo, y se corrige si la hay.
- **Simetría:** rotar o reflejar el escenario (la fuente y el gusano) da trayectorias rotadas o reflejadas.
- **Señales constantes:** con reorientación y giro fijos, el cuerpo hace lo esperado (recto, en círculo, con giros a la
  tasa dada).
- **Acciones desacopladas:** con las señales sin relación con el olor, el cuerpo **no** llega a la fuente más que por
  azar. Sirve de línea base para I3 e I12: si el cuerpo llegara solo, la navegación no sería del circuito.
- **Un circuito de juguete correcto** llega a la fuente: el lazo funciona de extremo a extremo.

## 9. Lo que percibe y lo que puede hacer el investigador

- **El percepto** depende de la faceta (§5).
- **`view`:** los estímulos, el estado del cuerpo, la concentración, las señales y el calcio de las células registradas.
- **`act`:** un episodio propio en lazo cerrado. Puede fijar:
  - la posición y el rumbo iniciales;
  - el campo, dentro de unos límites;
  - la duración;
  - las células registradas;
  - las intervenciones y los parámetros;
  - la semilla, en la condición aleatoria.
- **`act` con el cuerpo bloqueado:** el circuito sigue activo y oliendo, pero el cuerpo no se mueve. Con eso el
  investigador puede diseñar la prueba causal de I18:
  1. bloquear el movimiento y observar cómo cambian la corriente y las señales;
  2. reproducir después, en lazo abierto, la corriente del episodio original y comprobar si vuelve la dinámica
     original.

  La reproducción conserva el estado inicial y el de los filtros.
- **`act` con corriente reproducida** (en lazo abierto): repetir la corriente de un episodio en lazo cerrado. Es un
  **control de consistencia del instrumento:** con el mismo estado inicial y la misma corriente, las señales deben
  salir iguales. Por sí solo no demuestra un efecto causal del movimiento.
- **Episodios largos,** de minutos, para I17, con un coste que mide L0.

## 10. Coste

- **L0 lo mide:** NEURON frente a jNeuroML, para 9 s y para 60 s.
- **El lazo de control** añade poco: aritmética cada 5 ms dentro del proceso.
- **Los episodios largos y las réplicas** de la condición aleatoria multiplican el coste por simulación. El
  presupuesto de `act`, la longitud máxima y el número de réplicas son opciones del operador.

## 11. Las dos lecturas de los resultados

- **Hallazgos comprobados en este mundo:** lo que el investigador establece con sus experimentos, la auditoría del
  método y las pruebas propias. Es la lectura principal.
- **Correspondencia con EurekaBench:** la calificación con su rúbrica. Es aproximada, porque el cuerpo y el giro son
  nuestros, y así se dice.
  - Su juez es **binario** y exige que el mecanismo **derive** el *insight*, paso a paso, desde sus propios
    componentes. Una afirmación en el texto no basta, y un resultado que dependa sólo de los estímulos elegidos
    tampoco. Trata igual los hallazgos y las limitaciones (I13 a I18). Nuestro calificador endurecido (no saber no es
    saber) es coherente con ese criterio.
  - Se califican **por separado** los *insights* compartidos con `c302nav` y los que requieren cuerpo (I3, I5, I7, I9,
    I12, I17 e I18).
- **Comparación abierto/cerrado:** con el **mismo motor** (NEURON en los dos), la misma versión del código y runs
  emparejados.

## 12. Plan y preguntas abiertas

**Plan:**
- **L0. El motor.**
  - El usuario instala NEURON en su entorno, desde su terminal.
  - Exportar el panel y comprobar la fidelidad con tolerancias (§4).
  - Medir tiempos y comprobar la corriente variable paso a paso.
  - Comprobar la lectura incremental.
- **L1. El cuerpo y el campo:** las funciones de §8.1 y las verificaciones de §8.2 con circuitos sintéticos, sin c302.
- **Puerta antes de L2:** cerrar los contratos de §5 (orden temporal), §6 (azar) y §7 (evaluación de la navegación),
  con sus pruebas.
- **L2. El servicio y el laboratorio:**
  - `POST /closed-loop`, con idempotencia, 422 si diverge y JSON válido;
  - el laboratorio con las dos facetas, la condición determinista y los `act` (propio, con cuerpo bloqueado y con
    corriente reproducida);
  - el contrato de SPEC-ANOMALIAS-INSTRUMENTO desde el principio.
- **L3. Runs:** la condición N2 con junior y senior, en cuerpo determinista. Medidas en las dos lecturas (§11), y runs
  emparejados con `c302nav` sobre NEURON. La condición aleatoria, después.

**Preguntas abiertas:**
- **¿Cómo se huele exactamente?** AWC en el gusano real responde sobre todo a que el olor baje. Propuesta: una función
  de la concentración sin adaptación, para que la sensibilidad a la dirección del cambio (I4) salga del circuito y no
  del sensor.
- **¿Hace falta el cuerpo de c302 con músculos** (`simulate_body`)? Propuesta: no; el cuerpo es cinemático.
- **¿Qué límites tiene el investigador al fijar el campo en sus `act`?** Propuesta: la pendiente y la posición de la
  fuente dentro del rango de la familia.

## 13. Auditoría externa (06/10/2026): qué cambió

- **Evaluación de la navegación** (§7): varios horizontes con *rollout*, medidas alrededor de las reorientaciones,
  la referencia «mantén la velocidad angular reciente» y predicciones bajo intervención. Ya no se afirma que predecir
  el paso siguiente obligue a entender el lazo.
- **El azar** (§6): primero un cuerpo determinista; la condición aleatoria, con probabilidades o réplicas, nunca una
  trayectoria puntual.
- **El orden temporal** (§5), y la faceta de señales sin posición ni rumbo, para que el movimiento no revele la señal.
- **El control con corriente reproducida** es un control de consistencia; la prueba causal de I18 necesita además
  bloquear el cuerpo (§9).
- **Verificación del cuerpo por sí mismo** (§8.2): campo uniforme (deriva por la oscilación), simetrías, señales
  constantes, acciones desacopladas. Funciones concretas: tasa no negativa, probabilidad por paso, saturación, paredes y
  llegada (§8.1).
- **Fidelidad con tolerancias** sobre trazas, señales y tiempos de transición, con intervenciones y varios pasos, y la
  lectura incremental con el estado de los filtros (§4).
- **Las dos lecturas** (§11), observable no es demostrado (§1), I17 e I18 son *limitation*, la comparación usa el mismo
  motor y se califican por separado los *insights* que requieren cuerpo.
- **Comprobado con su juez:** exige derivación y trata igual hallazgos y limitaciones, lo que confirma el endurecimiento
  de nuestro calificador.
