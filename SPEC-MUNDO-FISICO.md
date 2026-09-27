# SPEC · Mundo físico: descubrir una ley de movimiento que nadie le ha contado

**Fichero:** `SPEC-MUNDO-FISICO.md`
**Estado (26/09/2026):** P1 implementada (mundo, leyes por nivel, sentido tabular, calibración: `lib/src/worlds/orbit/`,
`lib/scripts/calibrate-orbit.ts`, `lib/test/orbit.test.ts`). P2 implementada (predictor, prueba de predicción,
ablaciones: `lib/src/core/predict.ts`, `lib/src/worlds/orbit/predict.ts`, `lib/src/learn/law-ablation.ts`,
`lib/test/predict.test.ts`). P3 implementada (protocolo y prompt del explorador de leyes: `lib/src/learn/law-explorer.ts`,
`ORBIT_PERCEPT_DOC`, `lib/test/law-explorer.test.ts`). P4 implementada (runner con journal y métricas del operador:
`lib/scripts/run-orbit.ts`, `lib/src/worlds/orbit/describe.ts`, lanzadores `lib/run-orbit.example.*`; probado de punta a
punta con un LLM falso y el juez plano). P5: los tests se han ido escribiendo en cada fase; falta el primer run real. Segundo mundo del experimento de mundo desconocido
(ver `INFORME.md`, *Mundo desconocido: hallazgos de los runs 1–19*).

---

## 1. Objetivo

Comprobar si System 2 descubre por su cuenta **la ley que rige el movimiento de unos objetos**, con las mismas
herramientas y el mismo principio con que descubrió las reglas de los juegos generados. La ley es generada por
semilla y, a propósito, **distinta de las conocidas** (p. ej. una gravedad con exponente 2,37), para separar
"recuerda la física" de "descubre la física".

El criterio que manda es la **interpretabilidad humana**:
- del journal completo: un humano debe poder seguir qué sospechó System 2, qué experimento diseñó, qué vio y por
  qué cambió de idea;
- de la formulación matemática final: la ley aprendida debe leerse como una ley (código que mide con precisión
  más reglas en palabras que juzga Jev), no como una caja negra.

La tarea es **predecir**, no controlar. En una tarea de control, la búsqueda y los objetivos se interponen entre la
ley y el resultado, y una búsqueda con simulador podría cumplir la tarea sin necesitar la ley (el hallazgo "ganar no
demuestra entender"). Al predecir, cada ronda se juzga por algo que un humano entiende directamente: cuánto se
equivoca la ley.

## 2. Invariantes (heredados del experimento de la cuadrícula)

- **I1 · Sin fugas.** Ni System 2 ni Jev reciben la ley, sus parámetros, nombres con significado ("gravedad",
  "masa", "órbita") ni unidades. Los objetos se nombran con símbolos neutros y el sistema de referencia está girado,
  escalado y trasladado por semilla.
  **27/09/2026:** el envoltorio de cada petición a Jev (`lib/src/core/jev.ts`) decía "the position", "the game is in
  progress", "The board coordinates are intentionally absent" y llevaba `opponent`, también en orbit. En los mundos que no
  describen sus reglas ahora es neutro: el contrato, las medidas, los textos, quién tiene el turno y el hash. El juego del
  gato y el ratón, que sí describe sus reglas, conserva el envoltorio de siempre (paridad con el harness).
- **I2 · Sin investigación precocinada.** El entorno ofrece acciones primitivas (lanzar, simular, medir), nunca
  análisis hechos: no hay ajuste ni regresión que System 2 no escriba él mismo en código.
  **27/09/2026:** también en la cuadrícula. Se retiran de lo que ve System 2 las sondas (`probes`: AUC, medias por
  puntuación, test de azar), `surprises` (dónde falló más su modelo) y `record` con "tu mejor modelo" (el harness elegía
  sobre cuál construir). Siguen en el journal como `operator_analysis`. System 2 recibe hechos (`table` da las filas: el
  valor de su código en cada punto y la puntuación de su episodio) y los veredictos del protocolo; construye sobre su último
  modelo o el que elija.
- **I3 · Jev solo ve observaciones.** Ni la percepción ni el estado: solo los números y textos que calculan las
  observaciones de System 2, y las palabras de sus reglas.
- **I4 · Métricas del operador aparte.** La ley verdadera, el suelo de ruido, el mejor ajuste newtoniano y la nota
  de recuperación viven solo en el journal y nunca llegan a System 2 ni a Jev.
- **I5 · Cero pistas en el prompt (reforzado el 26/09/2026).** El prompt es genérico: una persona (inducción de
  investigador), un método de investigación y una explicación general de las herramientas y del protocolo. Nunca dice
  nada de la naturaleza del mundo ni del tipo de observaciones que convienen: ni qué se mueve, ni qué varía entre los
  sitios donde se comprueba la ley, ni que hay ruido o una región que no se ve, ni qué ley buscar. La tarea (qué se
  predice) y los parámetros de las herramientas son la interfaz; la forma de lo percibido la describe `percept`.
- **I7 · Un solo artefacto, sin forma impuesta (27/09/2026).** El modelo de System 2 es, en todos los mundos:
  observaciones (código), reglas (Jev), pesos sobre las reglas, V(s) = Σ wᵢ·rᵢ(O(s)), y `output` opcional
  (`lib/src/core/output.ts`). La interfaz de cada mundo dice solo la forma de la respuesta (un número de 0 a 1 por punto;
  un par por fila), nunca cómo construirla. La clave de la caché de Jev no incluye `output`: cambiarlo no cuesta llamadas.
- **I6 · Un solo prompt para todos los mundos (26/09/2026).** `lib/src/learn/prompt.ts` tiene el texto común (persona,
  método, herramientas, protocolo) con vocabulario común: episodio, paso, punto, modelo. Las herramientas tienen nombres
  comunes: `view`, `inspect`, `act` (antes `try` y `launch`), `replay` (antes `play`), `simulate`, `measure`, `table`,
  `probes`; los nombres antiguos se aceptan como alias. Cada mundo solo añade su interfaz (`GRID_INTERFACE`,
  `ORBIT_INTERFACE`): qué produce el modelo, cómo se combinan sus partes, los parámetros de cada herramienta y la forma del
  veredicto. Dos mundos con las mismas herramientas reciben el mismo texto común, palabra por palabra. Lo percibido se
  describe como estructura de datos (`p.series`, `p.next`, `p.step`), y los resultados llegan como puntuación de -1 a 1,
  nunca como "ganó" o "perdió". Un test lo vigila con una lista de palabras de ambos mundos.

## 3. El mundo `orbit@1`

### 3.1 Estado y dinámica

- Plano 2D. Uno o dos **cuerpos fuente** (fijos o casi) y uno o varios **cuerpos de prueba**.
- La aceleración de cada cuerpo de prueba es la suma de los términos de la ley oculta sobre cada fuente.
- Integración con un paso fino (p. ej. Verlet con subpasos); la percepción se muestrea a un paso Δt más grueso.
- El estado interno (`OrbitState`) guarda posiciones, velocidades, masas y el tiempo, en el marco verdadero.

### 3.2 Leyes generadas por semilla, por niveles

| Nivel | Ley oculta | Qué pone a prueba |
|---|---|---|
| L1 | a = k·M / r^p · r̂, con p ∈ [1,5; 3] excluyendo [1,9; 2,1] | Abandonar el prior newtoniano por los datos |
| L2 | L1 con dependencia de la masa del cuerpo de prueba m^q (sin principio de equivalencia) o masas ocultas por fuente | Descubrir variables ocultas con experimentos controlados |
| L3 | L1 + un término que depende de la velocidad (arrastre −c·\|v\|^s·v̂, o una desviación perpendicular a v) | Separar dos términos que actúan a la vez |
| L4 | Forma no potencial: apantallada k·e^(−r/λ)/r^p, suavizada k/(r²+ε²)^(p/2), o anisótropa según el ángulo en un eje oculto | Leyes que no son una potencia; regímenes distintos según la distancia |

Cada nivel se genera con parámetros por semilla, igual que los juegos de `worlds/grid/gen.ts`.

### 3.3 Calibración (solo para el operador)

Un script `calibrate-orbit.ts`, análogo a `calibrate-grid.ts`, acepta una semilla solo si:
- **La ley se puede distinguir de Newton**: dentro del rango que se puede explorar, el error del mejor ajuste
  r⁻² es claramente mayor que el suelo de ruido (p. ej. ≥ 3 veces).
- **Hay margen para aprender**: el evaluador plano (una constante) tiene un error alto.
- **La extrapolación discrimina**: en la banda de extrapolación, un ajuste que solo vale en el rango observado
  falla de forma medible.

## 4. Percepción

Un sentido predefinido, determinista a partir del estado:

```
     t      ◇ x      ◇ y      ◆ x      ◆ y
   0.00   12.41    -3.07     0.02     0.00
   0.25   12.36    -2.51     0.02     0.01
   ...
```

- Una tabla numérica por lanzamiento, en el marco girado, escalado y trasladado de la semilla, con símbolos
  neutros por cuerpo y ruido gaussiano σ en las posiciones.
- Sin velocidades ni aceleraciones: System 2 las deriva en código (diferencias finitas), igual que en la cuadrícula
  derivaba los movimientos legales.
- Opcional: un esbozo ASCII de las trayectorias como segundo sentido.

### 4.1 Discretización: flags del experimento

Hay dos cosas distintas que se pueden discretizar:

| Flag | Valores | Efecto |
|---|---|---|
| `--sampling` | `grid` \| `free` | **Dónde se evalúa la predicción.** `grid`: las muestras de la prueba caen en una malla fija de posiciones del mundo, que se repiten ronda tras ronda (la caché de Jev acierta; el coste baja). `free`: posiciones muestreadas libremente |
| `--resolution` | X ≥ 0 | **Precisión de la percepción.** Las posiciones llegan redondeadas a X; `0` = continua. Una malla gruesa hace más difícil distinguir exponentes cercanos: es un parámetro de dificultad |

Por defecto: `--sampling free --resolution 0`. Con el protocolo del investigador (§8.6) la ley se comprueba en lanzamientos
que System 2 no ha visto, y una malla fija deja de serlo desde la segunda ronda; `--sampling grid` queda como experimento
de coste. El journal guarda por ronda los aciertos de la caché de Jev (`jev.cache`) y el hash de la parte juzgada de la ley
(`judgment_hash`).

**Simulación sin Jev (26/09/2026, semilla 3, L1, montaje base, 8 rondas, parámetros por defecto):** las preguntas que se
repiten dependen solo del vector de observaciones, así que un juez falso da el ahorro exacto.

| Observación | Ley entre rondas | `free`: en vivo / puntos | `grid`: en vivo / puntos |
|---|---|---|---|
| distancia continua | igual | 986 / 988 | 136 / 1088 |
| distancia continua | cambia | 988 / 988 | 1088 / 1088 |
| bandas de log r (×4) | igual | 13 / 988 | 10 / 1088 |
| bandas de log r (×4) | cambia | 78 / 988 | 80 / 1088 |

`grid` solo ahorra cuando la parte juzgada de la ley (observaciones y reglas) no cambia entre rondas y las observaciones
son continuas; si cambia, no acierta nada de rondas anteriores. Si System 2 mide en bandas, `free` ya acierta más del 90 %
sin repetir puntos: el ahorro viene de discretizar, no de la malla.

**Hallazgo de P1:** `--resolution` está en las unidades del aprendiz, y la escala del marco varía por semilla (×0,3 a
×30). La misma resolución pesa mucho más en una semilla dibujada a escala pequeña. Con `--resolution 0.1`, 3 de 8
semillas de L1 dejan de tener margen (el suelo de ruido sube del ~0,3 % a entre el 0,6 % y el 5,8 %). La calibración
acepta la resolución como argumento y lo mide; queda por decidir si el flag debe ser relativo a la escala (§10).

El experimento de interés es `--sampling free --resolution 0`: **¿discretiza System 2 por su cuenta**, agrupando
sus observaciones en bandas? Si lo hace, vuelve a surgir el mecanismo de atención del run 17 sin que el mundo lo
imponga. La comparación "el mundo discretiza" frente a "System 2 decide discretizar" dice si ese mecanismo es un
rasgo general de la arquitectura o una casualidad del juego.

## 5. La fórmula: predecir con código y reglas

> **Sustituido el 27/09/2026 (I7).** Las componentes (dirección × magnitud, rango, escala) le decían a System 2 que la
> respuesta es una suma de vectores: una pista sobre la topología del mundo, y una invitación a escribir una regla por
> componente. Ahora el modelo es el mismo artefacto que en la cuadrícula: observaciones, reglas, pesos
> (V(s) = Σ wᵢ·rᵢ(O(s))) y `output` opcional, código `(p, m) => respuesta` con m = { observaciones, reglas, V }. Sin
> `output`, la respuesta es V(s). La tarea ya no nombra d: System 2 responde **la fila siguiente del último par de
> columnas**, y el entorno la convierte en d (respuesta − 2·p(ahora) + p(antes)) para el veredicto y la aceptación, que no
> cambian. Ablaciones: sin Jev (cada regla, una lectura logística ajustada de las observaciones, a través de su propio
> `output`), plano (una constante por regla) y delegado (Jev lee la tabla; `output` sigue leyendo sus observaciones). Lo
> que sigue describe el diseño anterior.

La misma estructura que en los juegos, V(s) = Σ wᵢ·rᵢ(O(s)), usada como **magnitud** de una componente de la
aceleración. Una ley es una lista de **componentes**:

```
â(s) = Σ_k  m_k(s) · d_k(s)

  d_k(s)  dirección: una observación en código que devuelve un vector unitario
          (p. ej. "hacia ◆", "contra la velocidad"): la geometría la calcula el código, exacta
  m_k(s)  magnitud: lo_k + (hi_k − lo_k) · Σ_i w_ik · r_ik(O(s)), o en escala logarítmica
          r_ik: reglas de Jev en palabras que citan observaciones ("la atracción hacia ◆, dado {{r}} y {{v}}")
          [lo_k, hi_k] y la escala (lineal | log) las declara System 2
```

- **Escala logarítmica.** Las magnitudes abarcan varios órdenes (r⁻²·³⁷ entre r = 1 y r = 20 varía unas 1000
  veces). Con una escala lineal, las respuestas de Jev (una probabilidad o una escala, no un número exacto) no
  tendrían resolución a distancias grandes. System 2 elige la escala; la ablación dirá si fue buena elección.
- **Qué se lee al final.** Por ejemplo: *"una atracción hacia ◆ cuya magnitud es la observación `pull` = r^-2.37
  (código), corregida por la regla `close_encounter` ('en un encuentro cercano con velocidad alta, la atracción
  efectiva es menor')"*. Código preciso más juicio en palabras.
- **Una ley toda en código es un resultado legítimo.** Si System 2 escribe la ley entera en una observación y la
  regla de Jev solo la transmite, la ablación lo mostrará: el código solo iguala a la fórmula. Dice **dónde vive
  la ley**, igual que en la cuadrícula.
- **Dónde puede aportar Jev de verdad:** en combinar y distinguir regímenes ("lejos del centro domina la inercia",
  "en un encuentro cercano domina el término de velocidad"), donde el código tendría que encadenar condiciones
  difíciles de leer.

### 5.1 Encaje con la biblioteca

- `Observer`, `Formula`, `JevJudge`, el hash semántico, las puertas estructurales y el cuaderno se reutilizan
  tal cual. Las observaciones de dirección devuelven un vector: se añade un tipo de salida vectorial (o dos
  observaciones escalares por componente; a decidir, §10).
- La composición por componente reutiliza la de `Evaluator` (V ∈ [0,1]) y la lleva al rango declarado.
- `orbit@1` no es un juego: un único actor (`nature`), `outcome` nunca terminado, sin búsqueda. Se implementa un
  `Predictor` al lado de `Evaluator`, en lugar de forzar el mundo al interfaz de juego.
- El contrato de Jev cambia en una frase: la respuesta de una regla no significa "bueno para mi bando" sino "dónde
  cae la magnitud dentro del rango declarado". El turno no se envía.

## 6. Instrumentos de System 2

| Instrumento | En la cuadrícula | En `orbit@1` |
|---|---|---|
| `view` | imagen de una posición | la tabla de un lanzamiento, o de un tramo |
| `launch` | `try` | lanzar un cuerpo de prueba desde (x, y) con velocidad (vx, vy) (y masa, desde L2) en el marco percibido; el mundo lo simula T pasos y devuelve la tabla (`launchN`). Es la **intervención controlada**: pares de lanzamientos que difieren en una sola variable |
| `measure` | código sobre posiciones | código sobre tablas: derivadas, residuos, ajustes escritos por System 2. Puede devolver un texto (sin rango) con varios números, p. ej. los parámetros de su propio ajuste |
| `simulate` | `play` | integrar **su propia ley** (una ronda, la mejor o un borrador) desde un estado observado y comparar con lo observado; nunca cuenta en el marcador |
| `inspect` | desglose de un turno | para una muestra: la respuesta de cada regla, el valor de cada observación, lo predicho frente a lo observado |
| `table` / sondas | observación frente a resultado de la partida | observación frente al **residuo** de su ley actual (concordancia, prueba de permutación con semilla): dónde se equivoca y con qué varía el error |
| cuaderno | creencias, notas, métodos | igual: creencias con postura obligatoria, notas que citan lanzamientos (`launch7@t=3.5`), métodos propios |

`--tools` funciona igual que en `run-grid.ts`, para la línea base sin instrumentos.

### 6.1 Decisiones de P3

- **Instrumentos:** `view`, `launch`, `inspect`, `measure`, `simulate`, `table`. Las sondas no existen como
  instrumento aparte: su papel (una observación frente a lo que pasó) lo cumple `table`, que devuelve cada punto con
  el **residuo** de la mejor ley. Si hace falta el resumen estadístico (concordancia, permutación), se añade después.
- **`launch` siempre ofrece `m`**, "una propiedad positiva del cuerpo que eliges" (1 por defecto), en todos los
  niveles. Donde la ley no depende de ella, descubrirlo también es un resultado; ofrecerla solo en L2 delataría el nivel.
- **`simulate`** integra con la propia definición de lo que se predice: siguiente = actual + último paso + d
  predicho. No añade física del harness.
- **El prompt no nombra ninguna ciencia ni cantidad del mundo.** Un test lo vigila con una lista de palabras
  (gravedad, masa, fuerza, órbita, atracción, energía, aceleración, inversa, cuadrado…). Dos correcciones de la
  primera versión: fuera "the pull of the latest result" (*pull*) y "root-mean-square" (ahora "quadratic mean").
- **Una lente retirada:** "una descripción válida en un marco debe valer en cualquier marco girado". Es falsa para
  las leyes anisótropas de L4, que tienen una dirección privilegiada: habría afirmado algo erróneo sobre el mundo.
- **Lentes de método que quedan**, genéricas: variar un argumento cada vez, cambiar de escala (una suma en una escala
  es un producto en otra), tratar lo que ya se cree de situaciones parecidas como una hipótesis, estimar el ruido
  desde las propias tablas, y que una ley es también lo que afirma al extrapolar. La del cambio de escala orienta
  hacia el análisis logarítmico; es guía de método permitida, pero conviene tenerla presente al leer los runs.

## 7. La prueba de cada ronda y la aceptación

- **Prueba:** N lanzamientos que System 2 no ha visto, nuevos en cada intento (el equivalente de `--variants`), una
  parte en una **banda de extrapolación** (distancias y velocidades fuera del rango que System 2 exploró).
- **Qué se mide:** el error de predicción de un paso (la posición tras Δt predicha con su aceleración, frente a la
  observada), y la divergencia al integrar varios pasos. Normalizado, por banda (interpolación y extrapolación).
- **Qué recibe System 2:** por lanzamiento de la prueba, las tablas observada y predicha y su error. Es el análogo
  de saber cómo terminó cada partida: un resultado objetivo, no un veredicto.
- **Aceptación:** error ≤ un umbral declarado por nivel en las dos bandas. System 2 solo sabe si se aceptó.
- **Marcador:** el error por ronda (menor es mejor), con la huella de la fórmula, como el `scoreboard` actual.

### 7.1 Decisiones y hallazgos de P2

- **Qué se predice.** En la fila i, cuánto se aparta la posición siguiente de repetir el último paso:
  d(i) = p(i+1) − 2·p(i) + p(i−1), leído de la propia tabla (con su ruido). Es una definición sobre lo percibido, no
  una ley: la ley tiene que explicarlo. El punto que ve el código es la tabla hasta la fila i, nunca la siguiente. Es
  la única elección del harness que roza el contenido físico (sugiere mirar el cambio del paso); se deja anotada
  como tal.
- **Una llamada a Jev por punto.** Todos los componentes leen las mismas observaciones y reglas; cada uno compone
  las respuestas con sus pesos. Con `--sampling grid` los puntos se repiten y la caché acierta (comprobado en test).
- **La direcciones son código del aprendiz sobre la percepción**, fuera del `Observer` (no llegan a Jev). Se
  resolvió así la pregunta abierta 1 sin tocar el `Observer`.
- **La métrica de error importa.** El error cuadrático relativo lo dominan los pocos puntos de encuentro cercano
  (aceleraciones grandes). En una prueba, la ley exacta daba 0,06 % frente a la verdad y 13,5 % frente a lo
  observado: ese 13,5 % es el suelo de ruido de esas muestras, no el 0,3 % de la calibración (tomado sobre otra
  distribución de puntos). Por eso la prueba informa también la mediana del error por muestra y, para el operador,
  el suelo medido sobre las mismas muestras (`floor`). La aceptación (P4) debe ser relativa a ese suelo.
- **El brazo "solo código" aplica la escala del componente** (lineal o log; ajuste por Gauss-Newton). Con un ajuste
  lineal ingenuo sobre una escala log, el código solo salía 5 veces peor y habría atribuido a Jev un mérito que no
  es suyo.
- **El brazo "solo código" se ajusta fuera de la muestra.** Ajustado y puntuado sobre las mismas muestras, llega a
  bajar del suelo (0,130 frente a 0,136: ajusta el ruido). En P4 se ajusta con los puntos de exploración y se
  puntúa en la prueba.

## 8. Ablaciones (información, no veredicto)

Sobre las mismas muestras de la prueba:

| Brazo | Qué es | Qué responde |
|---|---|---|
| Fórmula | la ley de System 2, con sus reglas de Jev | el resultado |
| Solo código | un ajuste (lineal o log-lineal, a elección del harness) sobre las mismas observaciones, sin Jev | ¿aportan las reglas de Jev algo que el código no expresa? Si el error baja con la regla, sí (como el 6–2 del run 17) |
| Plano | una constante por componente | el suelo |
| Modo delegado | Jev predice la magnitud a partir de la tabla completa como texto | la comparación limpia de los dos modos de la arquitectura |

### 8.1 Cómo quedó P4

- **Ronda:** System 2 investiga (hasta `--steps` respuestas), propone una ley, la ley se prueba sobre los lanzamientos
  de prueba de esa ronda (que quedan como suyos para estudiarlos, `test<ronda>-<k>`), y recibe los hechos: error por
  lanzamiento, si empezó dentro de la región que observa y los puntos que más falló. Se construye sobre la mejor ley.
- **Aceptación:** error ≤ `--accept` (1,2 por defecto) veces el suelo de ruido de los mismos puntos, en las dos bandas.
  El suelo es del operador; System 2 solo sabe si se aceptó.
- **Brazo "solo código":** ajustado con los puntos de los lanzamientos de System 2 y de exploración, puntuado en la prueba.
- **Coste:** con `--sampling grid`, la segunda prueba de la misma ley costó 0 llamadas a Jev en el ensayo (la caché
  acierta en todos los puntos).
- **Primer ensayo con LLM falso y juez plano (semilla 3, L1):** ley plana 0,99; solo código 0,19; plano 1,12;
  delegado 0,99 (el juez plano responde 0,5 siempre); suelo 0,136; Newton en el operador: 23 % dentro de la región,
  356 % fuera. En las peticiones a System 2 no aparece ninguna palabra delatora ni el exponente de la ley.
- **Lanzadores:** `run-orbit.example.ps1` / `.sh`; las copias con claves (`run-orbit.ps1` / `.sh`) están en `.gitignore`.

### 8.2 Primer run real y correcciones (26/09/2026)

**Run orbit 1** (semilla 3, L1, gpt-6-sol): aceptado en la ronda 5.
- **La física:** el exponente fue de 3 a 2,5, a 2,65 y a (r²+2)^-1,325 ≈ r^-2,65 (real 2,66), con coeficiente 640
  (real 656).
- **El método:** |d|·r^k constante a lo largo de las distancias; pares de lanzamientos para descartar que la masa importe.
- **Resultados:** abandonó Newton en la ronda 1 por los datos; nota de recuperación 0,9.
- **Tres problemas del harness:**
  1. **Esquivó a Jev.** Lo usó como calculadora ("probabilidad de U < x") y resultó mal calibrado (suelo ~0,1,
     sesgos de hasta 0,2), lo que explica casi todo el error de las rondas 1 a 4. En la ronda 5 escondió la magnitud en
     las direcciones: dos componentes fijos de 80 cuya parte lateral se cancela. Jev dejó de importar (1 llamada) y la
     ablación perdió sentido.
  2. **Con `--sampling grid` la prueba dejó de ser ciega.** Los lanzamientos de prueba se repiten y System 2 los
     estudió y ajustó el coeficiente con ellos.
  3. **El "suelo de ruido" no era ruido.** Era la diferencia entre la segunda diferencia sobre dos filas y la ley en un
     instante (a·Δt²), que crece en los pasos cercanos. System 2 lo detectó y lo atribuyó bien ("la fuerza varía dentro
     de la fila"); su "+2" en parte lo modela.

**Correcciones aplicadas:**
- **Magnitud en código.** Un componente puede declarar `magnitude: "(p) => number"` en lugar de pesos y rango. Jev no
  se consulta para ese componente, ni en absoluto si la ley no tiene reglas. La elección queda escrita en la ley, y la
  ablación registra qué componente lleva quién (`carried_by`).
- **Confirmación ciega en modo grid.** Una ley que pasa la prueba de la grid se confirma con lanzamientos nuevos que
  System 2 no ha visto ni verá, antes de aceptarse (evento `confirmation`).
- **Verdad = segunda diferencia sin ruido.** El `floor` es ahora solo ruido: 0,009 en la semilla 3, frente al 0,136
  anterior. Se añade la **referencia**: lo que la ley oculta misma puntúa en esos puntos (0,136).
- **Aceptación relativa a la referencia:** error ≤ `--accept` × max(referencia, suelo) por banda. Con el suelo de ruido
  puro ni siquiera la ley oculta se aceptaría: habría que modelar la integración numérica, que no es lo que se mide.
- **Peticiones ignoradas visibles.** El aviso incluye la petición tal como llegó (también en la cuadrícula).

Con la ley del run escrita en código, el ensayo reproduce su error (0,1329), la acepta tras la confirmación ciega
(0,19 en lanzamientos nuevos) y no hace ninguna llamada a Jev.

### 8.3 Segundo run y el veredicto del entorno (26/09/2026)

**Run orbit 2** (semilla 3, L1, gpt-6-sol, `5f33b53`): aceptado en la ronda 3, sin ninguna llamada a Jev.
- **Lo que hizo bien:** usó la magnitud en código sin trucos, descubrió la discretización y metió un integrador en su
  ley (ajusta la velocidad con las dos últimas posiciones e integra 16 subpasos).
- **La forma de la ley no era la verdadera:** 2000/(r² + min(25, 3r))^1,5, una cúbica suavizada. Vale en un intervalo
  (±5 % entre r = 8 y 25) y se aleja fuera (−32 % en r = 80), porque su pendiente tiende a −3. La ley del run 1 se
  mantenía en 1,00 ± 0,02 de r = 8 a 80.
- **En lanzamientos nuevos con pasos cercanos se hundió:** 0,76 frente a 0,34 de la ley oculta.

**Diagnóstico, del entorno y no de System 2:**
- *d* mezclaba la ley con la discretización.
- El error cuadrático relativo lo decidían los pocos pasos cercanos, así que la tarea premiaba parchear el centro y no
  veía la forma lejos.
- La grid le dejó afinar sobre la propia prueba.
- Sobre todo, **le dábamos una métrica** (error, mediana, peores puntos, "mejor ley") y la optimizó: descartó los
  errores lejanos "por su tamaño absoluto".

**Principio del usuario:** a System 2 no se le da ninguna métrica. Observa por su cuenta, y es el entorno el que dice si
su regla vale.

**Cambios:**
- **Muestreo 4 veces más fino** (una fila cada 0,125, 4 subpasos, 240 filas) con ruido 1e-5 y 6 decimales. La ley
  oculta queda en el ruido: 0,011 frente a 0,009 en la semilla 3, antes 0,141.
- **El veredicto del entorno.** En cada punto de cada lanzamiento de prueba, un vector con un número por eje de la
  tabla: tanh((d observado − d predicho) / |d observado|), en [−1, 1]. El 0 significa que no hay diferencia en ese eje;
  el resto lo interpreta System 2. Es relativo a lo que pasó en cada punto, así que un punto lejano pesa lo mismo que
  uno cercano. Los ejes son los de la tabla, no radial y tangencial, que delataría la dirección que importa.
- **Nada de números para System 2:** ni error, ni mediana, ni peores puntos, ni marcador, ni "mejor ley". Recibe los
  veredictos, si se aceptó la ley y su última ley; sobre cuál construye decide él. `table` da el residuo y el veredicto
  en cada punto.
- **Aceptación (oculta):** la media cuadrática de los veredictos de la ley ≤ `--accept` × la de la ley oculta en los
  mismos puntos, +0,02, en cada banda. Se exige en la prueba y en **dos** conjuntos nuevos de confirmación ciega.
- `--sampling free` por defecto.
- **Gradación de la fuerza aparte de su integración.** Integrar el movimiento dentro de la fila es cinemática, no un
  término de velocidad. Una forma que coincide solo en parte del rango es "parcial".

**Ensayo con LLM falso (semilla 3):**

| Ley | Veredicto | Ley oculta | Más allá de la región | Resultado |
|---|---|---|---|---|
| Por Jev (juez plano) | 1,23 | 0,09 | — | rechazada |
| La forma del run 2 (ajustada en r = 15) | 0,233 | 0,131 | 0,29 frente a 0,17 | rechazada |
| La forma verdadera | 0,0815 | 0,0808 | — | aceptada; confirmada con 0,090 y 0,088 |

### 8.4 El operador como investigador: una aceptación sin oráculo (26/09/2026)

**Límite acordado con el usuario:** el operador puede definir qué es ganar, perder o progresar, igual que un investigador
evalúa sus resultados, pero solo sobre cantidades observables. Nunca usa la verdad oculta para juzgar, ni hace el
análisis por System 2.

**Qué incumplía la versión anterior:** su aceptación comparaba con la ley oculta, que es la hoja de respuestas.

**Criterio nuevo: residuos compatibles con el error de medida más una precisión declarada.**
- El ruido σ² de cada componente de *d* se estima solo con lo observable: las fuentes no se mueven, así que las segundas
  diferencias de sus columnas en las mismas tablas son ruido puro.
- En cada punto: |d observado − d predicho|² / (2 (σ² + (ε·|d|)²)), con ε = `--precision` (1 % por defecto).
- Se acepta si la mediana por banda es ≤ `--accept` (2), en la prueba y en los dos conjuntos de confirmación ciega.
- Se usa la mediana porque un solo paso cercano dispara la media: en la semilla 2 llevaba la de la propia ley oculta a
  280.
- Se declara una precisión porque, con un ruido tan bajo, sin ella se exigía ~0,5 % y la ley oculta llegaba a 1,6 en
  algún conjunto.

**Medido en la semilla 3, sobre cinco conjuntos nuevos, con ε = 1 %:**
- la ley oculta queda entre 0,10 y 0,98;
- un 1 % de error en la intensidad pasa (≤ 0,63);
- un 2 % está en el límite (hasta 1,95);
- la forma del run 2 y Newton fallan por órdenes de magnitud.

La ley oculta queda solo como medida del operador en el journal.

**Ensayo con LLM falso:**

| Ley | Mediana de χ² (dentro / más allá) | Resultado |
|---|---|---|
| Por Jev (juez plano) | 13692 / 45665 | rechazada |
| La forma del run 2 | 8,7 / 4,0 | rechazada |
| La forma verdadera, con un 0,5 % de error | 0,32 / 0,86 | aceptada y confirmada (0,30 / 0,55 y 0,53 / 0,83) |

System 2 sigue recibiendo solo el veredicto por punto y si se aceptó.

### 8.5 Validar una ley como un investigador: invariancia entre entornos (26/09/2026)

#### Primeros principios

Un investigador no tiene la ley verdadera para comparar. Tiene su hipótesis, que predice; el mundo, que se observa; y la
posibilidad de montar experimentos distintos.
- Una hipótesis se da por buena cuando acierta **predicciones arriesgadas en condiciones en las que no se ajustó**
  (Popper).
- En particular, se da por buena cuando se mantiene **invariante al cambiar el montaje**. Lo que se sostiene entre
  entornos distintos es el mecanismo; lo que no, era ajuste. Es la idea de la predicción invariante en inferencia
  causal (Peters, Bühlmann y Meinshausen, 2016).

#### Por qué hace falta

Hasta aquí validábamos con lanzamientos nuevos, pero en el mismo mundo: misma fuente, mismo sitio, mismos ejes.
- Eso dejó pasar ajustes que no son principios. Las leyes de los dos runs escriben la posición de la fuente como
  constante (`cx = 7.572, cy = 2.271`) y una intensidad propia de esa fuente (640, 2000).
- Nada les obligaba a la **superposición**: qué pasa con dos fuentes.

#### El criterio

El entorno es una **familia de montajes**, todos regidos por el mismo principio: la forma de la ley y su exponente, que
salen de la semilla. Una ley se acepta si **predice el estado siguiente en todos los montajes de la prueba y en montajes
nuevos de confirmación ciega**, nunca vistos. Dentro de cada montaje, "predice" es el criterio observable de §8.4:
residuos compatibles con el ruido medido en las propias tablas más la precisión declarada. La ley oculta no interviene en
nada; queda como medida del operador.

#### Qué varía entre montajes, por etapas

| Etapa | Qué varía | Qué obliga a la ley |
|---|---|---|
| **1** (implementada) | La posición de cada fuente; el número de fuentes (1 a 3); el giro y el desplazamiento de los ejes de la tabla | Usar posiciones relativas a lo que se ve, no coordenadas memorizadas; sumar las contribuciones de varias fuentes |
| 2 (`--vary-strength`) | La intensidad ("masa") de cada fuente | **Inferir** la intensidad a partir de lo observado: la ley en código puede leer las filas anteriores de la tabla y estimarla, como se mide la masa de un planeta por la órbita de su luna |
| 3 (sin hacer) | La escala de los ejes (las unidades) | Nada de constantes en unidades fijas |

Tres cosas se mantienen fijas entre montajes porque forman parte del principio, no del montaje:
- **La intensidad universal**, en la etapa 1: una sola "G".
- **La orientación, en las leyes anisótropas (L4):** la dirección privilegiada es una propiedad del mundo, como la vertical.
- **La reflexión de los ejes:** en L3 una desviación "a la izquierda" se vería a la derecha en un mundo espejado, y eso
  ya no sería el mismo principio.

#### Cómo lo vive System 2

- Experimenta en los **montajes de laboratorio** (`lab1`, `lab2`) con sus lanzamientos (`"setup": "<id>"`).
- Su ley se prueba cada ronda en **montajes nuevos**. Sigue recibiendo el veredicto por punto y si se aceptó, y esas
  tablas pasan a ser datos suyos.
- ~~El prompt dice que el entorno es una familia de montajes regidos por un mismo principio.~~ **Retirado el 26/09/2026
  (I5):** era una pista. El prompt solo explica el protocolo: su ley se comprueba en sus laboratorios y, cuando la valida,
  en sitios que no ha visto. Qué cambia entre ellos lo descubre él.

#### Cómo quedó la etapa 1

- **`worlds/orbit/family.ts`:** `environmentOf(base, index)` genera montajes deterministas: 1 a 3 fuentes dentro de
  media región observable, separadas entre sí; giro y desplazamiento propios de los ejes. La ley, la escala, la unidad
  de tiempo y la reflexión se mantienen; la orientación también, si la ley es anisótropa.
- **El símbolo del cuerpo lanzado es el mismo en todos los montajes.** Se sortea primero, antes que las fuentes.
- **Laboratorios que difieren:** `lab1` es el mundo base (un cuerpo) y `lab2` un montaje con dos. Si no, System 2 solo
  descubriría la superposición al suspender una prueba.
- **La prueba** usa 3 montajes nuevos (`test<ronda><a|b|c>`), con 4 lanzamientos dentro de la región y 2 fuera en cada
  uno. La confirmación ciega son dos conjuntos más de 3 montajes nuevos.
- **El criterio es por montaje y por banda:** la ley tiene que sostenerse en cada uno, no en promedio. Con la mediana
  sobre todos los puntos juntos, un montaje fallido quedaba escondido si los otros tenían un solo cuerpo; lo vimos en el
  ensayo.
- **Hacen falta suficientes puntos por montaje** (un punto cada 8 filas y 6 lanzamientos). Con ~15 puntos, unos pocos
  pasos muy cercanos decidían la mediana, e incluso la ley oculta suspendía 2 de 60 montajes. Con los valores nuevos
  aprueba los 60, sin necesidad de excluir puntos.
- **`simulate` escribe las filas en el formato actual de la tabla** (6 decimales, cualquier número de cuerpos). Arrastraba
  el formato viejo.

**Ensayo con LLM falso (semilla 3):**

| Ley | Resultado |
|---|---|
| Por Jev | rechazada |
| La forma del run 2 | rechazada (5 a 155) |
| La ley correcta, pero relativa a un solo cuerpo (como la escribieron los dos runs reales) | rechazada en su propia prueba, en el montaje con varios cuerpos (342) |
| La ley sumada sobre todos los cuerpos | aceptada y confirmada en los 6 montajes ciegos (todos ≤ 0,76) |

#### Riesgos

- **Aprobar será más difícil.** El journal sigue mostrando el progreso: parecido con la ley real y veredictos.
- **Con varias fuentes hay trayectorias caóticas,** pero la predicción es de un paso, así que el caos no se acumula.
- **La etapa 2 necesita filas previas** antes de exigir predicciones.

### 8.6 El protocolo del investigador: dominar un montaje, validar, y convertir los fallos en laboratorios (26/09/2026)

Propuesta del usuario, que sustituye a la prueba de cada ronda en montajes nuevos. Probar cada ronda en toda la familia
movía muchos datos, aunque System 2 aún no dominara ni su propio laboratorio. Ahora se valida en la familia solo cuando
tiene sentido: cuando hay una ley que funciona donde nació.

1. **Un montaje.** System 2 empieza con un solo laboratorio (`lab1`, el mundo base). Cada ronda, su ley se **comprueba**
   allí, en lanzamientos que no ha visto de ese mismo montaje. Recibe los veredictos y si su ley se sostiene.
2. **Él decide cuándo validar** (`"validate": true` en la propuesta). Si la ley se sostiene en todos sus laboratorios,
   el entorno la valida en una **familia finita** de montajes que no ha visto (`--family 4`, con 1, 2 y 3 cuerpos
   representados) y vuelve a comprobar sus laboratorios (regresión). Tiene un presupuesto de validaciones
   (`--validations 3`); pedir una antes de tiempo se rechaza sin gastarla.
3. **Un montaje donde la ley no se sostiene pasa a ser laboratorio:** sus tablas son suyas y puede lanzar allí. La
   anomalía se convierte en el siguiente experimento.
4. **Cuando la ley se sostiene en toda la familia,** una **confirmación ciega** en dos conjuntos de montajes que nadie ha
   visto decide la aceptación. Es necesaria porque los montajes que fallaron y se estudiaron ya no prueban nada: solo lo
   nunca visto demuestra que la ley generaliza y no que fue superando, uno a uno, los montajes que se le mostraron.

**System 2 recibe:**
- sus laboratorios y los montajes de la familia donde validó;
- por montaje, si su ley se sostiene, con los veredictos por punto;
- si una validación se rechazó o convirtió montajes en laboratorios;
- cuántas validaciones le quedan.

Nunca recibe errores ni puntuaciones. El operador guarda en el journal los χ² por montaje, la ley oculta, las ablaciones
y la confirmación ciega.

**Ensayo con LLM falso (semilla 3, siempre pidiendo validar):**

| Ronda | Qué pasó |
|---|---|
| 1 | Ley por Jev: no se sostiene en `lab1` → validación rechazada, sin gastarla |
| 2 | Ley relativa a un cuerpo: se sostiene en `lab1` → valida: se sostiene en `setup3` (un cuerpo) y falla en `setup1`, `setup2` y `setup4` (varios) → **pasan a ser laboratorios** |
| 3 | La misma ley falla en los nuevos laboratorios (18 a 632) → validación rechazada |
| 4 | Ley sumada sobre todos los cuerpos: se sostiene en los 4 laboratorios → valida: `setup3` se sostiene → confirmación ciega en 6 montajes nuevos (todos ≤ 0,70) → **aceptada** |

### 8.7 Runs rápidos: `--quick` (26/09/2026)

Para ver si un cambio produce una exploración prometedora sin pagar toda la verificación. El run **para la primera vez que
System 2 pide validar** (da su ley por buena): no hay validación en la familia ni confirmación ciega. La comprobación en su
laboratorio sigue cada ronda, porque es de lo que aprende. La ley se imprime al terminar y queda en el journal (`quick_stop`,
con si se sostenía en sus laboratorios; `end.stoppedBy = "quick_stop"`). Implica `--no-ablation` y `--no-reflection`; la
calificación del operador se mantiene (`--no-grade` para quitarla). El prompt es el del protocolo completo, así que la
exploración es la misma que vería un run completo hasta ese punto.

## 9. Métricas del operador (solo en el journal)

- La ley verdadera y sus parámetros, en el marco percibido.
- **Suelo de ruido:** el error de la ley verdadera con el ruido de la percepción. Una ley de System 2 cerca de ese
  suelo ya no se puede mejorar con los datos disponibles.
- **Prior newtoniano:** el error del mejor ajuste r⁻². Mide cuánto se aleja System 2 de lo que "ya sabía".
- **Recuperación de la ley:** un LLM compara la ley final, las creencias y la reflexión con la ley verdadera,
  término a término (forma, exponente dentro de una tolerancia, dependencia de la masa, término de velocidad),
  exacto / parcial / erróneo / ausente, con evidencia. Como `operator_rule_recovery`, con `--no-grade`.
- Errores de cada brazo de la ablación, por banda.
- Llamadas a Jev por muestra, y la **razón de abstracción** (vectores de observación distintos frente a muestras
  distintas). En `--sampling free`, una razón baja es la señal de que System 2 discretizó por su cuenta.

## 10. Preguntas abiertas

1. **Salida vectorial:** ¿un tipo de observación que devuelve un vector (dirección), o dos observaciones escalares
   por componente? Lo primero se lee mejor; lo segundo no toca el `Observer`.
2. **Traducción de la respuesta de Jev al rango:** ¿basta la escala lineal/log declarada, o hace falta que una
   regla pueda responder en una escala de puntos más fina? La ablación lo dirá con datos.
3. **Presupuesto de lanzamientos por ronda:** en la cuadrícula, `try` era barato; aquí cada lanzamiento son T
   pasos. Propuesta inicial: 6 por ronda, como `--plays`.
4. **`--resolution` absoluta o relativa:** en unidades del aprendiz (lo que ve) o como fracción del tamaño de la región
   observable (misma dificultad en todas las semillas). Ver el hallazgo de P1 en §4.1.
5. **Coste en `--sampling free`:** sin caché, cada muestra de la prueba son llamadas a Jev. Limitar el número de
   muestras por ronda y registrar el coste.

## 11. Hipótesis que el experimento puede confirmar o refutar

- **H1:** System 2 abandona el prior newtoniano cuando los datos lo exigen, y el journal muestra en qué ronda y por
  qué experimento.
- **H2:** las reglas de Jev bajan el error frente al código solo en los regímenes que el código expresa mal (L3, L4).
- **H3:** con `--sampling free`, System 2 discretiza por su cuenta y el coste baja (mecanismo de atención emergente).
- **H4:** con instrumentos, la ley se recupera; sin ellos (`--tools none`), no, aunque el error pueda ser parecido
  en el rango observado. La extrapolación lo separa.
- **H5:** la ley final y el journal permiten a un humano reconstruir el descubrimiento sin leer el código del mundo.

## 12. Plan de implementación

| Fase | Contenido | Ficheros |
|---|---|---|
| P1 | Mundo, generador de leyes por nivel, sentido tabular con marco por semilla, calibración | `lib/src/worlds/orbit/`, `lib/scripts/calibrate-orbit.ts` |
| P2 | `Predictor` (componentes, escala lineal/log), prueba de predicción, ablaciones | `lib/src/core/predict.ts`, `lib/src/learn/ablation.ts` |
| P3 | Protocolo del explorador: `launch`, `simulate`, tablas de residuos, prompt sin ejemplos del entorno | `lib/src/learn/explorer.ts` (líneas por mundo) |
| P4 | Runner con journal y métricas del operador (suelo de ruido, Newton, recuperación, abstracción) | `lib/scripts/run-orbit.ts`, `lib/src/worlds/orbit/describe.ts` |
| P5 | Tests: sin fugas (ninguna palabra física ni parámetro en lo que ven System 2 y Jev), determinismo, calibración, ablaciones | `lib/test/orbit*.test.ts` |

Primer run propuesto: L1, `--sampling grid --resolution 0`, todos los instrumentos, y la misma semilla con
`--tools none` como línea base.
