# SPEC · Mundo físico: descubrir una ley de movimiento que nadie le ha contado

**Fichero:** `SPEC-MUNDO-FISICO.md`
**Estado (26/09/2026):** P1 implementada (mundo, leyes por nivel, sentido tabular, calibración: `lib/src/worlds/orbit/`,
`lib/scripts/calibrate-orbit.ts`, `lib/test/orbit.test.ts`). P2 implementada (predictor, prueba de predicción,
ablaciones: `lib/src/core/predict.ts`, `lib/src/worlds/orbit/predict.ts`, `lib/src/learn/law-ablation.ts`,
`lib/test/predict.test.ts`). P3–P5 pendientes. Segundo mundo del experimento de mundo desconocido
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
- **I2 · Sin investigación precocinada.** El entorno ofrece acciones primitivas (lanzar, simular, medir), nunca
  análisis hechos: no hay ajuste ni regresión que System 2 no escriba él mismo en código.
- **I3 · Jev solo ve observaciones.** Ni la percepción ni el estado: solo los números y textos que calculan las
  observaciones de System 2, y las palabras de sus reglas.
- **I4 · Métricas del operador aparte.** La ley verdadera, el suelo de ruido, el mejor ajuste newtoniano y la nota
  de recuperación viven solo en el journal y nunca llegan a System 2 ni a Jev.
- **I5 · Guía de método sin ejemplos del entorno.** El prompt puede enseñar cómo usar las herramientas, nunca qué
  ley buscar.

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

Configuración recomendada por defecto: `--sampling grid --resolution 0` (abarata sin degradar los datos).

**Hallazgo de P1:** `--resolution` está en las unidades del aprendiz, y la escala del marco varía por semilla (×0,3 a
×30). La misma resolución pesa mucho más en una semilla dibujada a escala pequeña. Con `--resolution 0.1`, 3 de 8
semillas de L1 dejan de tener margen (el suelo de ruido sube del ~0,3 % a entre el 0,6 % y el 5,8 %). La calibración
acepta la resolución como argumento y lo mide; queda por decidir si el flag debe ser relativo a la escala (§10).

El experimento de interés es `--sampling free --resolution 0`: **¿discretiza System 2 por su cuenta**, agrupando
sus observaciones en bandas? Si lo hace, vuelve a surgir el mecanismo de atención del run 17 sin que el mundo lo
imponga. La comparación "el mundo discretiza" frente a "System 2 decide discretizar" dice si ese mecanismo es un
rasgo general de la arquitectura o una casualidad del juego.

## 5. La fórmula: predecir con código y reglas

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
