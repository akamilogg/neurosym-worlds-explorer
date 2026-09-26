# SPEC · Semantic RuleNet: una red pequeña de reglas semánticas

**Fichero:** `SPEC-RULENET.md`
**Estado (26/09/2026):** propuesta, sin implementar. Aplica a los dos mundos del experimento: los juegos de cuadrícula
(`run-grid.ts`) y el mundo físico (`run-orbit.ts`, ver `SPEC-MUNDO-FISICO.md`).

---

## 1. Motivación

La fórmula de hoy es una neurona lineal cuyas entradas son juicios semánticos con nombre:

```
V(s) = Σ_i w_i · r_i(O(s))        w_i ≥ 0,  Σ w_i = 1,  V recortada a [0, 1]
```

Es la versión más limitada posible de una neurona: sin sesgo, sin pesos negativos, sin no linealidad y sin nodos
intermedios. No puede expresar "Y", "O", la inhibición ni un umbral. Los runs ya han mostrado casos donde eso cuesta:

- **Run 12 (cuadrícula, semilla 22).** System 2 entendió las dos condiciones de victoria: encerrar a `=` **o**
  alcanzar la columna derecha pierde. Una media convexa no expresa "si está encerrado, gano pase lo que pase": la regla
  del encierro pesó 0,2 y acabó desapareciendo. La comprensión no llegó a la fórmula.
- **Run orbit 1 (semilla 3, L1).** Usó a Jev como calculadora y resultó mal calibrado: un suelo de ~0,1 y sesgos de
  hasta 0,2. Una no linealidad sobre esas entradas las amplificaría. Es la advertencia principal de esta SPEC (§7).

La propuesta del usuario: convertir la fórmula en un **grafo semántico ejecutable**. System 2 declara reglas
semánticas (las juzga Jev), nodos intermedios que las combinan y un nodo de salida. El harness valida el grafo y hace
la aritmética.

## 2. División de responsabilidades (sin cambios de fondo)

| Quién | Qué |
|---|---|
| System 2 | Declara la topología: reglas semánticas, nodos, padres, operador, pesos, sesgos y activaciones (o pide que se ajusten, §5) |
| Harness | Valida el grafo (acíclico, padres existentes, límites), ejecuta la aritmética de forma determinista, ajusta parámetros si se pide |
| Jev | Juzga **solo** las reglas semánticas, con las observaciones. Nunca calcula un nodo |
| Resultados | Las partidas (o la prueba de predicción) seleccionan la red; la red aceptada queda congelada durante el juego |

Las activaciones, los sesgos y las combinaciones son cálculo del harness, no juicios de Jev.

## 3. El artefacto

```json
{
  "observations": { "...": "código sobre lo percibido, como hoy" },
  "rules": {
    "trapped": { "type": "noul", "instructions": "¿Tiene = alguna casilla libre? Movilidad: {{mobility}}", "criteria": { "yes": "...", "no": "..." } },
    "right_column_threat": { "...": "..." }
  },
  "nodes": {
    "i_win_now":   { "definition": "encerrado, o a punto", "op": "or", "parents": ["trapped", "one_move_from_trap"] },
    "i_lose_soon": { "definition": "= amenaza la columna", "op": "and", "parents": ["right_column_threat", { "not": "trapped" }] },
    "value":       { "definition": "valor para mi bando", "op": "linear",
                     "parents": ["i_win_now", "i_lose_soon", "formation"],
                     "weights": { "i_win_now": 3.0, "i_lose_soon": -2.5, "formation": 0.8 },
                     "bias": 0.0, "activation": "sigmoid", "centered": true }
  },
  "output": "value"
}
```

- **Entradas** de un nodo: reglas (respuestas de Jev en [0,1]), observaciones numéricas (escaladas a [0,1] por su
  rango) u otros nodos.
- **Una fórmula sin `nodes` es la de hoy**: su salida es un nodo implícito `mean` (la media convexa actual). La
  compatibilidad con todos los runs anteriores es total.
- En el mundo físico, la salida de la red de un componente es su V_k, que se lleva a su rango como hoy. Un componente
  con magnitud en código (corrección aplicada tras el run orbit 1) no tiene red.

### 3.1 Operadores

Empezar por operadores **lógicos declarativos**, que se leen de un vistazo, y añadir el lineal para lo que no cabe:

| `op` | Cálculo | Se lee como |
|---|---|---|
| `and` | min(x₁, …) (o producto, con `"tnorm": "product"`) | "A y B" |
| `or` | max(x₁, …) (o 1 − Π(1 − xᵢ)) | "A o B" |
| `not` (en un padre: `{ "not": id }`) | 1 − x | "no A" |
| `threshold` | σ((x − t) / suavidad) | "A por encima de t" |
| `mean` | Σ wᵢ xᵢ con wᵢ ≥ 0 que suman 1 | la fórmula de hoy |
| `linear` | act(b + Σ wᵢ x̃ᵢ), x̃ = 2x − 1 si `centered` | "A a favor, B en contra, con creencia base b" |

- `centered: true` hace que 0,5 aporte cero, >0,5 evidencia a favor y <0,5 en contra. El signo del peso dice si apoya o
  inhibe, y el sesgo expresa la creencia base.
- Activaciones: `identity` (recortada a [0,1]), `sigmoid`.

## 4. Validación del grafo

- Acíclico; cada padre existe (regla, observación numérica o nodo); `output` existe.
- Límites como guardas de ejecución, no como veredictos: por ejemplo ≤ 12 nodos y profundidad ≤ 4. Superarlos es un
  error de forma, como hoy un rango inválido.
- Una regla o un nodo que nada lee genera un aviso, como hoy una observación sin regla.
- El hash semántico de la fórmula incluye el grafo; el hash de juicio (la clave de la caché de Jev) **no**: las
  respuestas de Jev dependen solo de las observaciones y las reglas. Cambiar la aritmética de la red no cuesta ni una
  llamada: se recalcula sobre respuestas en caché.

## 5. Parámetros: declarados o ajustados

System 2 no ajusta bien los números a mano (en los runs de la cuadrícula casi nunca afinó pesos; el run 14 usó una
sola regla con peso 1 todo el run). Dos modos por nodo:

- **Declarado:** los pesos y el sesgo que escribe System 2.
- **`"fit": true`:** el harness ajusta pesos y sesgo con los datos **de System 2** (sus partidas y su resultado en la
  cuadrícula; sus lanzamientos en el mundo físico), con regularización hacia cero, y le devuelve los valores ajustados
  como hechos. La topología y el significado siguen siendo suyos. Es la división neurosimbólica clásica: estructura
  por razonamiento, parámetros por datos.

El ajuste usa solo fuentes propias (sin oráculo ni heurística ajena) y se valida fuera de la muestra: la prueba de la
ronda y, en modo grid, la confirmación ciega.

## 6. Interpretabilidad

- Cada nodo lleva `definition`. `inspect` muestra, por nodo: valor de entrada, valor de salida y **contribución** a la
  salida (wᵢ·x̃ᵢ en un nodo lineal; el padre que decide en un min/max). Ejemplo de lectura: "`formation` = 0,81
  favorecía, pero `escape` = 0,92 activó `containment_failure` a 0,87 y su arista negativa bajó el valor en 0,31".
- El marcador da a System 2 los **hechos** de complejidad de cada red: nodos, aristas, capas Jev, llamadas por prueba.
  La elección entre una red más simple y una más compleja es suya; el harness no aplica un fitness que decida por él.
  (Los veredictos del instrumento ya se convirtieron antes en creencias falsas; ver `INFORME.md`.)
- La guía de método ya incluye la lente de longitud mínima de descripción; no hace falta añadir otra.

## 7. Riesgos

1. **Amplificación de la mala calibración de Jev.** Una sigmoide con pesos grandes sobre respuestas con sesgos de 0,1 a
   0,2 multiplica el error (el run orbit 1 lo mostró con un rango log). Mitigación: preferir operadores lógicos
   (min/max no amplifican), registrar la sensibilidad ∂V/∂xᵢ de cada entrada en el journal (operador) y que `inspect`
   muestre las respuestas reales de Jev para que System 2 lo detecte, como ya hizo.
2. **Pérdida de interpretabilidad por tamaño.** Con los límites de §4 y los hechos de complejidad en el marcador. Los
   runs sugieren que el riesgo real no es el tamaño (System 2 usa 1 a 3 reglas) sino los números opacos: de ahí los
   operadores lógicos primero.
3. **Sobreajuste con `fit`.** Regularización, ajuste con datos propios y validación fuera de la muestra.
4. **Dependencias semánticas entre reglas.** Las preguntas de una misma petición a Jev son independientes: una no puede
   leer la respuesta de otra. Los nodos de §3 son todos aritméticos (una sola capa Jev, ninguna llamada extra). Los
   **nodos Jev de segundo nivel** (Jev recibe las activaciones de los padres) quedan fuera de esta SPEC: solo si un run
   muestra una relación que ningún operador declarativo expresa honestamente.

## 8. Ablaciones

Sobre las mismas partidas o puntos de prueba, además de las actuales:

| Brazo | Qué responde |
|---|---|
| Red de System 2 | el resultado |
| Misma red, reglas sustituidas por una lectura ajustada de las observaciones (sin Jev) | ¿qué aportan los juicios? |
| Mismas reglas, media convexa (sin nodos) | ¿qué aporta la no linealidad? |
| Misma topología, parámetros ajustados frente a declarados | ¿acierta System 2 los números? |

## 9. Trabajo relacionado (para citarlo al publicar)

- **Concept Bottleneck Models** (una predicción lineal sobre conceptos interpretables) y sus variantes con conceptos
  generados por un LLM. La red de §3 es un *bottleneck* de conceptos con capas lógicas encima.
- **Sistemas neuro-difusos** (ANFIS y similares): reglas difusas con parámetros ajustables. Los operadores min/max de
  §3.1 son t-normas y t-conormas.
- **Logic Tensor Networks** y la programación neurosimbólica: lógica diferenciable sobre predicados aprendidos.

Lo propio de este proyecto: los conceptos los **inventa System 2** a partir de sus propios experimentos, en un mundo que
no conoce; los **juzga otro LLM** a partir de medidas en código; y la topología se valida con resultados reales.

## 10. Hipótesis y runs que la justificarían

- **H1 (cuadrícula, semilla 22).** Con nodos `or`/`and`, System 2 lleva a la fórmula las dos condiciones de victoria
  que en el run 12 entendió pero no pudo expresar, y la red gana más que la media convexa con las mismas reglas.
- **H2 (orbit L3/L4).** Donde hay regímenes (un término de velocidad que domina en pasos rápidos, una atracción
  apantallada), un nodo `threshold` o `linear` sobre juicios de régimen baja el error frente a la media convexa.
- **H3.** Las redes siguen siendo pequeñas (≤ 5 nodos) sin que el harness lo imponga más allá de los límites de forma.
- **H4.** Con `fit`, los parámetros ajustados superan a los declarados; sin él, System 2 usa sobre todo operadores
  lógicos.

Si en H1 y H2 la red no mejora a la media convexa, la SPEC no se justifica y no se sigue adelante.

## 11. Plan

| Fase | Contenido |
|---|---|
| R1 | Tipos, validación, hash, composición en el `Evaluator` (cuadrícula) y en el `Predictor` (orbit); sin `nodes` = comportamiento actual |
| R2 | Parseo en los dos exploradores y prompt (operadores y ejemplo genérico, sin nada del entorno) |
| R3 | `inspect` con valores y contribuciones por nodo; journal con sensibilidades (operador) |
| R4 | `fit` con regularización, ajustado con datos propios |
| R5 | Ablaciones de §8 |
| R6 (opcional) | Nodos Jev de segundo nivel, solo si un run lo pide |

## 12. Preguntas abiertas

1. ¿`centered` por defecto en los nodos lineales? (Recomendado: sí.)
2. En la cuadrícula, ¿un término de código directo en la salida, como la magnitud en código de orbit? Hoy toda la
   información llega a V a través de una regla de Jev; permitirlo haría a Jev opcional también allí.
3. ¿Los límites de §4 (12 nodos, profundidad 4) son razonables, o mejor más estrictos al principio?
