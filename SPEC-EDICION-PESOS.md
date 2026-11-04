# SPEC · Edición de pesos: el modelo fuerte escribe en los pesos del junior, y una búsqueda evolutiva los explora

Estado (04/11/2026): **WE1 a WE5 implementadas** (edición y composición; laboratorio de pesos, constructores cerrados y
backend aislado; la palanca en el mundo del junior; la búsqueda; el atasco y la rama del operador; §12). Falta WE6, que
necesita la línea base real. Dos revisiones externas del mismo día conciliadas (§14). Amplía
[SPEC-METAPOLITICA-APRENDIZAJE](SPEC-METAPOLITICA-APRENDIZAJE.md) con una palanca nueva de la fase A, entre la
decodificación y la destilación, y con una búsqueda evolutiva sobre ella. Reutiliza el
[motor evolutivo](SPEC-DELEGACION-EVOLUTIVA.md), las ramas de [delegación](SPEC-DELEGACION-INVESTIGACIONES.md), la
escalera de competencias, las sondas y `paired-cases@1`.

## 1. De dónde sale

[Weight-Space Programming](https://rikiyat.github.io/blog/weight-space-programming/) describe un modelo frontera que lee
y escribe los pesos de una red directamente, sin descenso de gradiente. El resultado que nos concierne es su experimento
8. Editó el 0,016 % de los pesos de **Qwen3.5-0.8B** (por ejemplo, restando una dirección de las columnas de salida de una
MLP), con un presupuesto de 50 llamadas de evaluación; cada llamada podía procesar lotes enteros (hasta 512 problemas o
1.024 textos), no una sola respuesta. MATH-500 pasó del 7,9 % al 48,1 %, GSM8K del 13,8 % al 67,1 % e IFEval del 21 % al
62,3 %. Gran parte de la mejora consistió en quitar un obstáculo: las respuestas que agotaban el límite de tokens bajaron
del 93 % al 33 %.

Lo que el artículo acota de sus propios resultados:

- En Gemma 3 270M la edición no mejoró nada. Los autores concluyen que quitó un obstáculo que ocultaba una capacidad,
  pero no añadió una que faltaba. Es lo que mostró **ese** ensayo; el mismo artículo escribe redes completas desde cero.
- Leer el comportamiento sólo de los pesos falló; con acceso a activaciones y patrones de atención, acertó.
- Son resultados tempranos de un solo equipo. No hablan de búsqueda evolutiva ni de que un modelo grande siembre a otros.

Nuestro junior es Qwen3.5-4B con un ordenador compilado delante. Lo que se espera de él en la fase A son sobre todo
obstáculos: formato, peticiones mal formadas, no consultar su memoria, respuestas que no terminan. Esta spec convierte esa
evidencia en **una palanca medible** y en **una fuente de diversidad** para cuando el junior deja de mejorar: el modelo
fuerte propone ediciones como hipótesis, y una búsqueda evolutiva las combina, las varía y añade material propio.

Dos hipótesis se ponen a prueba, no se dan por supuestas (§8):

- **H1.** Las ediciones del modelo fuerte mejoran al junior más que perturbaciones aleatorias del mismo tamaño.
- **H2.** Las mejoras obtenidas editando pesos (en los peldaños 1 a 4, medidos por sondas) se transfieren a
  investigaciones completas: más mundos resueltos (peldaño 6), con confirmación externa. Si eso se debe a desbloquear una
  capacidad que ya estaba o a construir una nueva no lo distingue ninguna evaluación: queda como hipótesis causal (E1).
  Corregir el protocolo o evitar bucles puede bastar para terminar investigaciones que antes fallaban, que es justo el
  mecanismo que motiva esta propuesta.

## 2. Principios

- **E1. Una edición es una hipótesis.** Cada edición declara qué cree que corrige, en qué competencia y por qué, antes de
  medirse. La interpretación del mecanismo queda registrada como **hipótesis causal** del modelo fuerte; lo único que la
  respalda como mejora son las evaluaciones.
- **E2. El circuito no se toca.** Ninguna edición alcanza las capas del ordenador compilado ni sus cabezas DeltaNet. Una
  versión editada pasa la misma validez que una entrenada (SPEC-METAPOLITICA-APRENDIZAJE §10.1) antes de evaluarse.
- **E3. Tres usos de los datos, separados por grupos** (§4.1):
  - el **diagnóstico** construye las intervenciones: de ahí salen las activaciones y fallos que usa el modelo fuerte;
  - la **selección**, visible, orienta la búsqueda: el investigador y los operadores ven sus medidas;
  - la **confirmación**, reservada, acredita el resultado fuera de la máquina.

  Lo que se construye no se calcula sobre los casos que seleccionan, pero la búsqueda sí ve cómo puntúan sus candidatos:
  eso es desarrollo visible, y por eso existe la confirmación.
- **E4. Lo ajeno se declara.** Una edición escrita por el modelo fuerte es ayuda ajena, con su autoría en la procedencia,
  como lo destilado.
- **E5. Todo se reconstruye.** Cada edición es un artefacto por hash, con el constructor o programa que la produjo y sus
  entradas, y cada versión se recompone siempre igual desde su partida (§3.2).
- **E6. Sin control no hay conclusión.** Toda comparación de ediciones del modelo fuerte lleva su control: ediciones
  aleatorias del mismo tamaño agregado, en los mismos módulos.

## 3. La edición y su composición

### 3.1 `weight-edit@1`

Una edición es un cambio aditivo sobre módulos de Qwen, `ΔW`, en una de dos codificaciones:

| Codificación | Qué guarda | Para qué |
|---|---|---|
| `lowrank` | Factores `B` (d_out × r) y `A` (r × d_in) por módulo, `ΔW = B·A` | Restar o añadir direcciones. Restar la dirección `d` de la salida de un módulo es `ΔW = −d·(dᵀW)`, de rango 1 |
| `sparse` | Índices y valores por módulo | Cambios puntuales en unas pocas entradas |

Cada edición incluye:

- **Módulos e índices de capa**, todos de Qwen. Se rechaza cualquier capa menor que `chip_layers` del paquete.
- **Su hipótesis** (E1): competencia, mecanismo supuesto y efecto esperado.
- **Su origen**, uno de cuatro:
  - `written`: los valores, escritos directamente por el modelo fuerte;
  - `constructor`: uno de los constructores cerrados del arnés (§4.3), con sus argumentos y entradas por hash;
  - `program`: código libre del modelo fuerte, sólo con un backend aislado (§4.4);
  - `operator`: producida por un operador de la búsqueda (§6.3) a partir de otras, con sus padres.
- **Autoría:** modelo fuerte, búsqueda o control aleatorio.
- **Sus valores materializados por hash**: los factores o índices definitivos, aunque los haya producido un constructor o
  programa. Recomponer una versión nunca vuelve a ejecutar un programa; verificarla sí (§10).

### 3.2 Composición: siempre desde la partida, una sola vez

Una versión editada se define por tres cosas, y las tres forman parte de su identidad:

- **El paquete de partida**: un paquete inmutable, sin adaptador, del que sale la búsqueda o la palanca. Es distinto de la
  **referencia de evaluación** del manifiesto (aunque al empezar suelan coincidir): la partida dice de qué pesos se parte;
  la referencia, contra qué se compara.
- **El genoma**: la lista ordenada de ediciones.
- **La regla de composición**, versionada (`compose@1`):
  1. Para cada módulo tocado, se suman en fp32, en el orden del genoma, todos los `ΔW` que lo tocan. Una edición
     `lowrank` se suma **rango a rango**, como productos exteriores `B[:,k]·A[k,:]` con `k` en orden: cada producto se
     redondea a fp32 y cada suma también, sin reducciones. Nunca con un producto de matrices de librería, cuyo orden de
     suma depende de la librería, del hardware y de los hilos, y daría otros bits en la máquina de confirmación. Una
     `sparse`, entrada a entrada, con índices estrictamente crecientes.
  2. Se aplica una vez a **todas** las entradas del módulo: `W' = redondeo_bf16( fp32(W_partida) + ΔW_total )`, con
     redondeo al par más cercano.
  3. Nunca se aplica una edición sobre pesos ya editados.

El orden importa en bf16: partiendo de 256, dos incrementos de 0,75 dan 256 si se redondea tras cada uno y 258 si se
acumulan primero en fp32. La regla fija el segundo. Por eso **ninguna librería de fusión sirve aquí**: fusionar un LoRA
(PEFT) convierte `ΔW` a bf16 y lo suma sobre bf16, que son dos redondeos, uno más por adaptador. Tras componer se
registra, por módulo tocado, el resumen de sus pesos antes y después; dos composiciones del mismo genoma deben dar los
mismos resúmenes.

La regla está escrita dos veces con la misma aritmética: la referencia del arnés, sin modelo, y el trabajador, en torch
sobre el modelo servido. El trabajador dice los resúmenes de lo que sirve, antes y después de componer. El servidor los
compara con los del conjunto: si el «antes» no coincide, el módulo servido no es el tensor del checkpoint con ese nombre;
si no coincide el «después», compuso otros pesos. En ambos casos la respuesta queda sin verificar y la validez falla.

Consecuencias:

- **`edit` sobre una versión ya editada** crea un hijo cuyo genoma es el del padre más la nueva edición, recompuesto desde
  la partida. El artefacto del padre no se sustituye ni se reaplica.
- **Padres con LoRA:** se rechazan. Combinar un adaptador entrenado con ediciones es otra receta, que no existe todavía.
- **En el paquete,** el genoma compuesto ocupa el sitio del adaptador como un árbol por hash con formato
  `weight-edit-set@1`. El exportador recorre los ficheros de ese árbol, no las referencias escritas dentro de un JSON: por
  eso **el árbol contiene como ficheros todo lo necesario para componer**, nunca sólo sus hashes:
  - su manifiesto: la partida (por hash de ejecución), el genoma en orden, la regla y los resúmenes por módulo;
  - cada edición: su manifiesto (módulos, hipótesis, origen, autoría) y sus tensores materializados (factores, o índices
    y valores);
  - para cada edición de constructor o programa, sus entradas (activaciones, casos de diagnóstico por hash con su
    contenido) y el constructor o programa: lo que hace falta para **verificar** que el valor materializado es el que
    producen.

  El trabajador reconoce el formato y compone según la regla, leyendo sólo ficheros del árbol. Así un paquete exportado
  viaja completo a la máquina de confirmación (MA6) y se recompone allí sin acceso al run que lo produjo.

### 3.3 Tamaño de una intervención

Tres medidas distintas, calculadas sobre la **intervención compuesta** de cada módulo (no sumando ediciones, que pueden
solaparse o cancelarse):

| Medida | Qué cuenta |
|---|---|
| Tamaño de representación | Parámetros guardados: entradas de `A` y `B`, o índices y valores |
| Entradas cambiadas | Entradas de `W'` que difieren de `W_partida` tras redondear. Un cambio de rango 1 puede cambiarlas todas |
| Norma relativa | `‖ΔW_total‖ / ‖W_partida‖` por módulo |

**Las cotas las fija el manifiesto autorizado de la condición**, por módulo y en total: fracción máxima de entradas
cambiadas, norma relativa máxima y rango o número de entradas máximos. Un candidato puede declarar cotas más estrictas,
nunca más laxas. Una intervención compuesta fuera de cotas se rechaza antes de evaluarse.

- **El rango es una cota conservadora, declarada como tal.** Se mide `rank_bound`, la suma de los rangos de las
  ediciones `lowrank` del módulo, que acota por arriba el rango de su parte de bajo rango compuesta. Así,
  `diag(1,0) + diag(0,1) = I` cuenta como rango 2 y una edición más su opuesta también cuenta 2, aunque se anulen. El
  rango numérico exacto exigiría una tolerancia propia. Las entradas `sparse` se acotan aparte, por su número.
- **Una composición que no es finita no es una versión.** Factores finitos pueden desbordar fp32 en sus productos o
  sumas (+∞ y −∞ suman NaN), y una suma finita en fp32 puede no caber en bf16. Se rechaza antes de crear el paquete,
  aquí y en el trabajador. Una medida que no es un número nunca cuenta como dentro de una cota.
- **La verificación recalcula todas las medidas** (por módulo y totales), las compara con las registradas y aplica las
  cotas del conjunto. También comprueba que esas cotas son válidas, que no son más laxas que las autorizadas cuando se
  conocen y que `chip_layers` coincide con el circuito del paquete.

## 4. El laboratorio de pesos

El modelo fuerte necesita observar al junior para proponer ediciones. Lo hace con un instrumento nuevo que corre en la
máquina del junior, en un proceso propio. Sólo lee.

### 4.1 Qué casos puede consultar

El manifiesto declara tres conjuntos de grupos disjuntos (E3): **diagnóstico**, **selección** y **confirmación**. El
laboratorio sólo ejecuta casos de diagnóstico: cortes de runs de desarrollo de esos grupos, o textos escritos por el
propio modelo fuerte. Nunca ejecuta sondas de selección ni casos de confirmación. Las capas del circuito pueden leerse,
para entender, pero nunca editarse.

Los grupos de diagnóstico van en el campo `weight_lab.diagnosis` del manifiesto de competencia, cada uno con sus runs.
Al validar el manifiesto se comprueba que esos grupos no son el grupo de ningún caso y que esos runs no los corta
ninguna sonda. Al consultar, un corte de un run que no sea de diagnóstico se rechaza. También se rechaza un corte cuyo
hash coincida con el de una sonda.

### 4.2 Operaciones y sus límites

| Operación | Qué devuelve |
|---|---|
| `modules` | La lista de módulos editables, con sus formas |
| `weights.stats` | Normas, los primeros valores singulares y percentiles de un módulo |
| `weights.slice` | Un trozo acotado de una matriz |
| `forward` | El junior sobre uno o varios casos de diagnóstico: tokens generados, sus k primeros logits por posición y la razón de parada |
| `activations` | Normas y direcciones principales de la salida de unos módulos, en unas posiciones |
| `attention` | Patrones de atención resumidos de unas cabezas |
| `try` | Como `forward`, con una intervención candidata compuesta según §3.2 en una copia |

Cada operación es una **consulta** y cuenta en la bolsa `lab_queries`. Además, cada consulta respeta límites efectivos que
fija el manifiesto, y lleva en su recibo lo que consumió:

- tokens de entrada y de salida, sumados sobre todos los casos de la consulta (bolsa `lab_tokens`);
- pasos del circuito;
- tiempo de reloj y memoria pico;
- tamaño de la respuesta: número de entradas de un `slice`, de valores singulares, de posiciones y cabezas.

Las lecturas que no ejecutan al junior (`modules`, `weights.stats`, `weights.slice`) no gastan tokens, pero sí cuentan como
consultas y tienen sus propios límites de tiempo, memoria y tamaño. **Todas pasan por la cola de recursos del junior**
(SPEC-METAPOLITICA-APRENDIZAJE §11): la GPU de inferencia no se reparte fuera de ella.

La unidad del artículo era distinta: una llamada podía procesar cientos de casos. Aquí una consulta también puede llevar
varios casos de diagnóstico, y por eso el presupuesto se cuenta en consultas **y** en tokens.

Cómo queda en el código:

- **Un trabajo del libro del junior.** Cada consulta es un trabajo del libro de trabajos, con su `operation_id`.
  - Reserva una unidad de `lab_queries` y, si ejecuta al junior, el máximo de `lab_tokens` que permite el manifiesto.
  - Liquida lo que consumió. Repetida con el mismo identificador es la misma consulta y no se cobra dos veces.
- **El tiempo.** Una consulta que agota su tiempo detiene el proceso del laboratorio. Como no puede decir lo que
  consumió, su reserva queda como incierta.
- **Los límites que sólo se miden después.** Si una consulta supera los tokens, la memoria pico o el tamaño de
  respuesta, se cobra igual, pero su respuesta se retiene (`over_limit`). Lo que permiten los argumentos se comprueba
  antes de enviarla.
- **El proceso y la cola.** El laboratorio corre en su propio proceso de trabajador, pero en la cola única del servidor:
  la GPU de inferencia no se reparte fuera de ella.
- **`try`.** Compone el conjunto candidato sobre los módulos que toca, ejecuta la consulta interior (`forward` o
  `activations`) y restaura esos módulos.
- **`activations`.** Guarda, por caso y módulo, la media de la salida en las posiciones pedidas, como un fichero de su
  recibo. De ahí salen las entradas de `mean_difference`.

### 4.3 Constructores cerrados

La vía por defecto para producir una edición a partir de lo observado es un **constructor** del arnés: código fijo,
determinista y versionado, sin código del modelo fuerte. El modelo fuerte sólo elige el constructor y sus argumentos. Los
de la primera versión:

| Constructor | Qué produce |
|---|---|
| `project_out(module, d)` | Quita la dirección `d` de la salida del módulo: normaliza `d̂ = d/‖d‖` y produce `ΔW = −d̂·(d̂ᵀW)` |
| `add_direction(module, u, v, α)` | `ΔW = α·u·vᵀ` |
| `mean_difference(module, casos_a, casos_b, posiciones)` | La dirección media de la diferencia de activaciones entre dos conjuntos de casos de diagnóstico, normalizada |
| `top_singular(module, k)` | Las k primeras direcciones singulares del módulo, para usarlas como `d` |
| `scale_rows(module, filas, α)` / `scale_cols(module, columnas, α)` | Escala filas o columnas: un cambio `sparse` o de rango bajo |

Cada constructor comprueba sus argumentos antes de producir nada: dimensiones que casan con el módulo, valores finitos,
vectores no nulos. Una dirección que se usa como tal se **normaliza dentro del constructor**, y se registra normalizada:
sin eso, `project_out` con `W = I` y `d = [2, 0]` daría `diag(−3, 1)` en vez de `diag(0, 1)`, amplificando e invirtiendo
lo que debía quitar. Un argumento inválido rechaza la edición.

Sus entradas (casos, activaciones) se toman de consultas al laboratorio, con sus recibos. Repetirlos con las mismas
entradas da el mismo `ΔW`; el verificador lo comprueba. Cada constructor fija también su aritmética. `project_out@1`,
por ejemplo, suma cada `A_j = Σ_i d̂_i·W_ij` en orden creciente de `i`, en float64, y redondea una vez.

Implementados, cada uno con su versión:

- **`project_out@1`**, desde WE1.
- **`add_direction@1`**: `û` y `v̂` normalizadas, `ΔW = α·û·v̂ᵀ`.
- **`mean_difference@1`**: la diferencia de medias de las activaciones de dos lados, normalizada, aplicada como
  `ΔW = α·d̂·(d̂ᵀW)`. Con `α = −1` la quita.
- **`top_singular@1`**: las `k` primeras direcciones singulares, con `ΔW = α·U_k·(U_kᵀW)`. Las calcula una iteración de
  subespacio determinista (vectores iniciales sembrados, número fijo de iteraciones, Rayleigh-Ritz). Es una aproximación
  declarada que da los mismos bits en cualquier máquina.
- **`scale_rows@1` y `scale_cols@1`**: un cambio `sparse` `α·W` sobre las filas o columnas elegidas.

Todos comprueban sus argumentos y registran sus entradas normalizadas. La actualización de rango 1 de ROME, construida a
partir de claves y valores de activación, queda como referencia para un constructor futuro, implementando la fórmula y no
la librería, que no conoce este modelo.

### 4.4 Programas libres

El origen `program` (código escrito por el modelo fuerte, como en el experimento 6 del artículo) sólo se admite con un
**backend aislado** que garantice:

- ninguna red;
- pesos de solo lectura;
- escritura sólo en su carpeta;
- límites de tiempo, memoria y CPU.

El sandbox de procesos actual (`processSandbox`) **no** sirve: se declara no aislado. WE2 entrega ese backend como
aislamiento de procesos locales del sistema operativo de la máquina del junior, sin Docker ni servicios que haya que
instalar aparte. Mientras no exista, una edición `program` se rechaza al pedirse; los constructores cubren la palanca.

El backend es `linux-userns-landlock@1`:

- **Mecanismo.** Un lanzador corre dentro de `unshare --user --map-root-user --net`, lo que deja el programa sin red.
  Landlock le quita todo derecho de escritura salvo en su carpeta, así que los pesos quedan de solo lectura. Los
  `rlimit` acotan la memoria, la CPU y el tamaño de lo que escribe, y el arnés lo mata al acabar su tiempo.
- **Disponibilidad.** **Nunca se supone.** Sólo se declara disponible cuando su autoprueba, ejecutada en el mismo
  aislamiento, demuestra cada garantía: una conexión rechazada, una escritura fuera de su carpeta y otra en la base
  rechazadas, una escritura dentro y una lectura de la base hechas. En Windows, o en un núcleo sin Landlock, no está
  disponible y dice por qué. `lab junior isolation` ejecuta la autoprueba.
- **Contrato del programa.** Lee sus entradas en `inputs/` y la base en `$JUNIOR_BASE`. Escribe en `out/` un
  `modules.json` con `{module, encoding, shape, file}` y los ficheros de tensores.
- **Origen registrado.** El código viaja como la entrada `program.py`.
- **Verificación.** Vuelve a ejecutar el programa en su backend (`verifyPrograms`). Sin backend, esa edición queda
  **incompleta**: nunca cuenta como verificada.

## 5. La palanca en el mundo del junior

Se añaden dos actos a `junior-competence@1`:

- **`inspect_weights`**: una consulta al laboratorio de pesos (§4). Devuelve un episodio de lecturas y lo paga de sus
  bolsas.
- **`edit`**: crea una versión hija con una edición más (§3.2). Lleva:
  - la versión de origen, cuya partida y genoma hereda;
  - la edición (escrita, constructor o programa);
  - su hipótesis y lo que espera, como un `change`.

  Antes de evaluarse, la versión pasa las cotas y la validez del circuito. Cada edición se paga de la bolsa `edits`.

Las versiones editadas se miden, se comparan y se promueven como cualquier otra: escalera, sondas de selección,
investigaciones y `paired-cases@1` contra la referencia de evaluación. Se confirman igual, fuera de la máquina (MA6). En
la confirmación, el resumen declara `edited` junto a `distilled` y `trained`.

Cómo queda en el código:

- **Dónde vive el conjunto.** Una versión editada guarda su conjunto en el fichero `edits.json` de la versión, escrito
  por el mundo y nunca por un `change`, y su paquete lo lleva en el hueco del adaptador.
- **Qué hereda.** Un `change` de una versión editada conserva sus pesos. Un `edit` sobre ella alarga su genoma. Un
  `train` sobre ella se rechaza.
- **Su procedencia** declara `edit-set:` y cada `edit:`, y la confirmación lo lee como `edited`, no como `trained`.
- **`edit`** lleva una de tres formas: `written` (valores), `construct` (un constructor cerrado, con entradas tomadas de
  una consulta de `inspect_weights` o escritas) o `program`. Lleva también la competencia que corrige, su `why` (el
  mecanismo supuesto) y su `expect` (el efecto), que forman la hipótesis de la edición (E1), y unas cotas más estrictas
  opcionales.
- **Qué cuesta.** Una edición rechazada no cuesta nada: `edits` sólo se paga cuando nace una versión.
- **`inspect_weights`.** Su identificador de operación lo fija lo que pregunta, así que repetida es la misma consulta.
  Si una consulta se rechaza, el investigador ve el motivo.
- **El prompt.** Los dos actos sólo se explican en el prompt de un run que los paga (`--edits` o `--lab-queries`). Así,
  el prompt de las configuraciones sin ellos no cambia.
- **Reconstrucción.** Una ejecución reconstruida vuelve a crear la versión editada desde el registro del mundo
  (`edits.jsonl`), sin componer de nuevo ni volver a cobrarla.

Orden de las palancas, de más barata a más cara: prompt, memoria inicial, decodificación, **edición de pesos**,
destilación, LoRA. La edición va antes que la destilación porque no entrena nada. Va después de la memoria porque cambia
pesos y exige pasar la validez.

## 6. La búsqueda evolutiva de juniors

Cuando la palanca individual no basta, una búsqueda explora muchas ediciones a la vez, sobre un candidato nuevo: el
**genoma** sobre una partida fija.

**No usa la política del motor evolutivo existente** (`lib/src/learn/evolve`), y la razón está en ella misma: esa política
planifica parches de ficheros que pide a un mutador LLM (local, rewrite, repair, recombination, restart). Aquí casi todos
los operadores son código sobre tensores y el archivo es por nichos. Por eso es una búsqueda propia, `weight-search@1`,
que conserva los principios del motor:

- identificadores estables;
- un registro de eventos escrito antes y después de cada efecto;
- el archivo reconstruido desde el registro sin modelo;
- una búsqueda reanudada que no vuelve a medir ni a cobrar lo que ya midió.

### 6.1 Genoma

Un genoma es una lista ordenada de ediciones `weight-edit@1`. Su fenotipo es la versión compuesta según §3.2.

- La identidad de un candidato es la partida, el genoma, la regla de composición y su configuración de servicio.
- Las cotas se comprueban sobre la intervención compuesta (§3.3), con los límites del manifiesto de la búsqueda.

### 6.2 Semillas

La población inicial tiene tres orígenes, en proporciones fijadas por el manifiesto de la búsqueda:

- **Semillas del modelo fuerte.** Las propone después de diagnosticar los fallos de la partida en casos de diagnóstico.
  Se le pide un número fijado de hipótesis **distintas** (mecanismos o módulos diferentes), no variantes de una sola.
- **Semillas de control aleatorio** (E6). Intervenciones aleatorias en los mismos módulos, con el mismo rango y la misma
  norma relativa compuesta que las semillas del modelo fuerte.
- **El genoma vacío**, que es la partida.

### 6.3 Operadores

| Operador | Qué hace | Quién lo aplica |
|---|---|---|
| `refine` | Lee los fallos de un candidato en casos de diagnóstico y propone una edición que lo corrija o complemente | El modelo fuerte |
| `scale` | Multiplica una edición por un factor | Código |
| `drop` | Quita una edición del genoma | Código |
| `combine` | Une las ediciones de dos genomas | Código |
| `retarget` | Mueve una edición a la capa vecina del mismo tipo | Código |
| `sparsify` | Pone a cero las entradas más pequeñas de una edición `sparse` | Código |
| `perturb` | Añade a los factores de una edición `lowrank` un ruido aleatorio acotado (por norma relativa) | Código |
| `reinit` | Sustituye las direcciones de una edición por otras aleatorias del mismo rango y norma, en el mismo módulo | Código |

`scale`, `drop`, `combine` y `sparsify` desarrollan el material recibido, y `retarget` lo desplaza. **`perturb` y `reinit`
introducen material nuevo sin llamar al LLM:** direcciones que nadie propuso, que es parte de la diversidad que se busca.
Los operadores de código son deterministas dada su semilla; cada hijo guarda sus padres, el operador y la semilla.
`refine` es ayuda ajena (E4) y se cuenta aparte en el presupuesto. Para `combine`, los métodos de fusión de modelos
(TIES, que elige signo por entrada, y DARE, que descarta al azar y reescala) son variantes naturales. Se escriben sobre los
factores de las ediciones, no sobre checkpoints completos como hace mergekit.

### 6.4 Evaluación en cascada

Cada candidato pasa por filtros de menor a mayor coste. El estado en el que queda es uno de estos:

1. **Cotas y validez del circuito** (§3.3, E2). Si no las pasa, es **inválido**: no se evalúa, y se conserva con su
   diagnóstico como posible punto de partida de una reparación.
2. **Sondas de selección**, con el número de respuestas de la regla de §6.3 de la spec base. Si su evaluación queda
   incompleta (infraestructura, presupuesto), es **sin medir**: no entra en nichos ni es élite, y puede medirse después.
   Si se completa, es **medido**.
3. **Investigaciones completas**, sólo para las élites de cada nicho (§6.5). Sus resultados se adjuntan como **evidencia
   posterior**: no cambian el nicho del candidato.
4. **Confirmación externa**, sólo para el candidato que se quiere promover.

Un candidato medido sin mejora demostrada **sigue siendo desarrollable**: puede ser padre. Sólo es inválido el que no
pasa el paso 1.

### 6.5 Nichos y calidad

La búsqueda mantiene un **archivo por nichos**, al estilo MAP-Elites, con el mejor candidato medido de cada nicho.

**El nicho** se calcula sólo con lo que se mide en el paso 2, para que todo candidato medido tenga uno:

- **Qué mejora:** para cada componente de las sondas (peldaños 1 a 4), el signo de su diferencia de déficit con la partida
  (mejora, igual, empeora). Lo de los peldaños 5 y 6, que sólo miden las investigaciones, queda como evidencia posterior.
- **Dónde actúa:** el grupo de capas y el tipo de módulo con mayor norma relativa en su intervención compuesta.

Las fronteras de «igual» (una tolerancia por componente) y los grupos de capas se fijan en el manifiesto de la búsqueda
antes de empezar.

**La calidad dentro de un nicho** es una regla ejecutable, la misma del motor existente:

1. El vector de déficits normalizados de los componentes de sondas (§6.3 de la spec base), comparado del peor componente
   al mejor; gana el menor.
2. Desempates, en este orden: menor norma relativa compuesta; menos entradas cambiadas; el creado antes.
3. Un candidato sin medir no compite. Un componente al que le falta un dato deja el vector incompleto y el candidato sin
   medir: nunca se rellena con déficit cero.

`paired-cases@1` no ordena el archivo: decide la **promoción** de un candidato contra la referencia de evaluación (§7).

### 6.6 Cuándo se abre

La búsqueda se abre de una de tres formas:

- **El investigador fuerte la pide** con el acto `evolve`: fija la partida, el presupuesto y los descriptores, dentro de
  lo que autorice el manifiesto.
- **El arnés la propone por atasco.** Si en K evaluaciones seguidas ninguna versión se promueve y los déficits no se
  mueven, el mundo avisa por el canal de mensajes de que puede abrir una búsqueda. No la abre por su cuenta.
- **El operador la lanza** como rama de delegación, con su propio fondo.

Lo que devuelve son versiones con su procedencia completa (partida, genoma, padres, operadores, semillas y autoría), que
el investigador adopta o no.

Cómo queda en el código (WE4):

- **Lo autorizado.** `weight_search` en el manifiesto fija el máximo de candidatos, el mínimo de semillas de control
  (al menos 1), los pesos de los operadores, las tolerancias de cada componente de sondas, los grupos de capas, el ruido
  de `perturb` y si se investigan las élites. `evolve` se mueve dentro de eso.
- **Las semillas.** El investigador las da en el acto como ediciones (`written`, `construct` o `program`), cada una con
  su hipótesis. Dos semillas con los mismos módulos y el mismo origen se rechazan por ser la misma hipótesis.
- **Los controles.** Cada semilla de control toma una semilla fuerte (en ciclo), sortea factores o entradas aleatorios
  en los mismos módulos, con el mismo rango o número de entradas, y los escala para que la norma relativa compuesta de
  cada módulo sea la de la fuerte. Su autoría es `control`.
- **El coste.** Cada genoma compuesto es un trabajo de `edits` y cada candidato medido con sondas uno de `evaluations`,
  los dos idempotentes por lo que piden. Agotar una bolsa detiene la búsqueda con su archivo.
- **Las élites** se registran como versiones del mundo, con su conjunto en `edits.json`, su nicho y su origen.
- **`refine`.** En el mundo no se usa: el modelo fuerte es el propio investigador, que siembra y vuelve a abrir
  búsquedas. La búsqueda lo admite con un `refine` inyectado.
- **Combinar.** `combine` une genomas. Las variantes TIES y DARE quedan como mejora.

Cómo queda en el código (WE5):

- **El atasco.**
  - Sólo se mide en un run que puede abrir una búsqueda: el manifiesto autoriza `weight_search` y `weight_edits`, y el
    run paga `edits`.
  - Las K últimas evaluaciones de versiones (`weight_search.stuck_after`, 4 por defecto) cuentan como atasco si
    ninguna se ha promovido y ningún componente mejora el mejor déficit anterior más allá de su tolerancia.
  - El mundo lo publica en el canal tras un acto o una comprobación, como hechos: cuántas evaluaciones, qué versiones,
    ninguna promovida, déficits sin moverse, y que `evolve` está disponible.
  - Cada atasco se dice una sola vez (`stalls.jsonl`). El mundo nunca abre la búsqueda.
- **La rama del operador** (`lab junior branch <weight-search-branch.json> --dir <dir>`).
  - Tiene el ciclo de vida de toda rama delegada: registro, latido con su proceso, buzón de parada, hallazgo, y además
    el registro de su búsqueda y un libro propio con su fondo (`edits`, `evaluations`), aparte de las bolsas del
    investigador.
  - Su mundo es una instancia propia sobre los mismos blobs y el mismo servidor, es decir, en la cola única de la GPU.
  - Reanudada, no vuelve a medir. Terminada, no vuelve a correr.
  - El mundo del investigador lee las ramas terminadas (`--weight-branches`), registra sus élites como versiones desde
    la versión de partida y las entrega una vez por el canal, como contribución delegada: ni una orden ni una respuesta
    del mundo.
  - El investigador no pide esta rama con `delegate`: para eso tiene `evolve`. La rama es la vía del operador. Como en las ramas evolutivas existentes, lo que importa es que abra líneas que el
investigador no tenía, no que su primer resultado se promueva.

## 7. Medida y promoción

- Un candidato se promueve como cualquier versión: `paired-cases@1` contra la referencia de evaluación, con las
  tolerancias de los componentes protegidos.
- La selección es desarrollo visible (E3): un candidato elegido mirándola muchas veces puede sobreajustarse a ella. Por
  eso **la confirmación externa es obligatoria** antes de anunciar una mejora. La búsqueda registra cuántas evaluaciones
  hizo sobre las mismas sondas, y el manifiesto puede limitarlo.
- **La retención** se mide con los componentes protegidos y la suite de validez. Una edición puede romper capacidades
  ajenas a la que corrige: eso es una regresión.

## 8. La comparación que dice si sirve

Las hipótesis H1 y H2 se ponen a prueba con condiciones fijadas antes de empezar, desde la misma partida y con el mismo
presupuesto total:

| Condición | Qué se hace |
|---|---|
| A | Sin cambios de pesos: prompt, memoria y decodificación |
| B | Ediciones del modelo fuerte, una a una (§5) |
| C | Ediciones aleatorias de control, del mismo tamaño compuesto (E6) |
| D | Búsqueda evolutiva con semillas del modelo fuerte (§6) |
| E | Búsqueda evolutiva sólo con semillas aleatorias y operadores de código |
| F | Destilación y LoRA (MA4, MA5) |

Lo que se lee:

- **H1:** si B supera a C y D a E. Si no, las hipótesis del modelo fuerte no aportan más que el azar, y eso también es un
  resultado.
- **H2:** si lo que cada condición mejora en las sondas (peldaños 1 a 4) se transfiere al peldaño 6, mundos resueltos con
  confirmación externa. Si no se transfiere, las ediciones arreglan síntomas que no bastan para investigar mejor. Por qué
  se transfiere, cuando lo hace, queda como hipótesis causal.
- **El coste** de cada mejora: tokens del modelo fuerte, consultas y tokens del laboratorio, evaluaciones y horas de GPU.
- **La diversidad:** nichos ocupados, y cuántos se ocuparon con material de `perturb` y `reinit`.

## 9. Presupuesto

Se añaden tres bolsas a las de la spec base:

- **`lab_queries`**: consultas al laboratorio de pesos (§4.2);
- **`lab_tokens`**: tokens de entrada y salida de esas consultas;
- **`edits`**: versiones editadas creadas.

Las evaluaciones siguen saliendo de `evaluations`, y los tokens del modelo fuerte (diagnóstico, semillas, `refine`) de
su bolsa. Una búsqueda reserva antes de empezar el máximo que puede gastar de cada bolsa y se detiene al agotarlo,
conservando su archivo.

## 10. Registro y reconstrucción

Se reconstruyen sin modelo:

- cada edición, desde sus valores materializados;
- cada versión, recomponiendo su genoma desde su partida con su regla, y comprobando los resúmenes de cada módulo;
- cada genoma, desde sus padres, operadores y semillas;
- el archivo de la búsqueda, desde su registro: el nicho y la calidad de cada candidato se recalculan de sus medidas.

La verificación vuelve a ejecutar cada constructor con sus entradas registradas y comprueba que da los mismos valores. Un
programa libre sólo se vuelve a ejecutar en su backend aislado; sin él, la verificación de esa edición queda incompleta.

## 11. Límites

- **La evidencia de partida es débil.** Es un artículo temprano, con un modelo frontera concreto y otro tamaño de junior.
  Si en nuestras condiciones no reproduce, la palanca queda como opción probada y descartada.
- **Un 4B no es un 0,8B, y lleva un ordenador delante.** Las direcciones que importan pueden ser otras, y la cercanía al
  circuito exige cuidado extra en la validez.
- **Desbloquear y construir no se distinguen evaluando** (H2): sólo se mide si la mejora se transfiere. El artículo mostró
  un caso en que la edición no mejoró nada, y otros en que se escribieron redes desde cero.
- **El modelo fuerte necesita contexto** para leer pesos y activaciones. Las respuestas del laboratorio se acotan para
  que quepan.
- **El sobreajuste a la selección** se mitiga, pero no se elimina, con la confirmación externa y el tope de evaluaciones.

## 12. Entregas

| Etapa | Depende de | Entrega |
|---|---|---|
| **WE1 · Edición y composición** | MA5 | `weight-edit@1`, `weight-edit-set@1` con todo lo necesario como ficheros del árbol, regla `compose@1`, partida separada de la referencia, medidas de tamaño y cotas del manifiesto, padres con LoRA rechazados, aplicación en el trabajador y validez del circuito |
| **WE2 · El laboratorio de pesos** | WE1, MA2 | Operaciones con sus límites y bolsas, en la cola del junior; partición diagnóstico/selección/confirmación; constructores cerrados con verificación; backend aislado para programas libres, sin Docker (sin él, `program` se rechaza) |
| **WE3 · La palanca** | WE2 | Actos `inspect_weights` y `edit` en `junior-competence@1`; `edited` en la confirmación |
| **WE4 · La búsqueda** | WE3 | Genoma sobre partida fija, semillas del modelo fuerte y de control, operadores (incluidos `perturb` y `reinit`), cascada con estados inválido/sin medir/medido, archivo por nichos de sondas con su regla de calidad; acto `evolve` |
| **WE5 · El atasco** | WE4 | Aviso por el canal cuando el junior se estanca; la búsqueda como rama de delegación |
| **WE6 · La comparación** | WE4, primera línea base real | Las condiciones A–F de §8, lanzadas por el operador |

**WE1 a WE5 se prueban con el driver de imitación** (`lib/test/fixtures/fake-driver`) y modelos sustitutos. **WE6
necesita la máquina real y la línea base de la fase A.**

**WE1, hecha (04/11/2026):**

- **Dónde está.** `lib/src/junior/weights.ts` contiene `weight-edit@1`, `compose@1` de referencia, medidas y cotas,
  `weight-edit-set@1` y su verificación, y `project_out@1`. Las cotas autorizadas van en el manifiesto de competencia
  (`weight_edits`). `lib/src/junior/junior_weights.py` es el compositor del trabajador: torch sobre el modelo servido y
  Python puro para el backend de imitación.
- **Pruebas.** Las de `lib/test/junior-weights.test.ts` cubren las aceptaciones 1 a 4, 12 y 13. Entre ellas, la
  comparación bit a bit del compositor de TS con el de Python. `lab junior package` verifica un conjunto de ediciones
  sin modelo.
- **Formato de tensores.** Viajan como safetensors escritos por un escritor propio, con nombres ordenados y sin
  metadatos, para que unos mismos tensores den los mismos bytes.
- **Pendiente en la máquina real.**
  - La ruta torch, `apply_edit_set`: comparar sus resúmenes con los de la referencia en un módulo de Qwen.
  - Que los nombres de módulo del checkpoint sean los de `chat.model`. Si no lo son, el resumen del «antes» lo detecta.

**WE2, hecha (04/11/2026):**

- **Dónde está.**
  - `lib/src/junior/weight-lab.ts` contiene la configuración `weight_lab` del manifiesto, los límites, las consultas
    con sus recibos y `construct` con entradas tomadas de los recibos.
  - `lib/src/junior/junior_lab.py` tiene las operaciones: un modelo de imitación para las pruebas y hooks de torch para
    el Qwenputer.
  - Hay una ruta `/lab` en el servidor, dentro de su cola, con un trabajador de laboratorio propio.
  - Los constructores están en `weights.ts`.
  - El backend aislado está en `lib/src/junior/isolation.ts` y `junior_isolate.py`.
- **Pruebas.** `lib/test/junior-weight-lab.test.ts` cubre las aceptaciones 5 y 6. La prueba del backend aislado real
  sólo corre en Linux.
- **Pendiente en la máquina real.**
  - El backend Qwenputer del laboratorio: la pasada con *teacher forcing* sobre el flujo (logits, hooks de activación),
    que `attention` devuelva patrones en las capas de atención completa (las DeltaNet no tienen) y el tope de memoria
    por consulta.
  - La autoprueba del aislamiento. Ubuntu 23.10 y posteriores pueden restringir los espacios de nombres de usuario sin
    privilegios: si la autoprueba falla, `program` sigue rechazado y los constructores cubren la palanca.

**WE5, hecha (04/11/2026):**

- **Dónde está.** El atasco (`stall`) y la entrega de las ramas (`deliverBranches`) están en el mundo. La rama del
  operador está en `lib/src/junior/weight-branch.ts`, y el subcomando es `lab junior branch`.
- **Pruebas.** Están en `lib/test/junior-weight-stall-branch.test.ts`.
- **Un ciclo de importación arreglado de paso.** Ya existía antes de WE5: cargar primero el mundo del junior fallaba
  (`junior/lab.ts` → `competence.ts` → `labs.ts` → `junior/lab.ts`). El registro de laboratorios ahora lee el mundo del
  junior cuando se le pide, no al construirse.

**WE4, hecha (04/11/2026):**

- **Dónde está.** La búsqueda está en `lib/src/junior/weight-search.ts`: genomas, semillas fuertes distintas, controles
  del mismo tamaño, operadores, cascada, nichos, regla de calidad, reconstrucción y reanudación. El acto `evolve`, la
  evaluación sólo con sondas (`probesOf`) y el evaluador de búsqueda están en el mundo. `weight_search` va en el
  manifiesto.
- **Pruebas.** `lib/test/junior-weight-search.test.ts` cubre las aceptaciones 7, 8, 9 y 11.

**WE3, hecha (04/11/2026):**

- **Dónde está.** Los actos `inspect_weights` y `edit` están en `lib/src/worlds/junior/lab.ts`, con las bolsas
  `lab_queries`, `lab_tokens` y `edits` y las opciones `--lab-queries`, `--lab-tokens`, `--edits` y `--lab-python`. La
  confirmación (`confirm.ts`) declara `edited`.
- **Pruebas.** Están en `lib/test/junior-weight-edit-world.test.ts`. Cubren:
  - lecturas cobradas una vez;
  - versiones editadas que pasan la validez;
  - genomas que se alargan;
  - rechazos que no cuestan nada;
  - un constructor alimentado por activaciones del laboratorio y probado con `try`;
  - la reconstrucción.

## 13. Aceptación

1. Una edición en capas del circuito o sin hipótesis se rechaza antes de crear la versión; una intervención compuesta
   fuera de las cotas del manifiesto, también, aunque cada edición por separado esté dentro.
2. `edit` sobre una versión editada produce un hijo cuyo genoma extiende el del padre, recompuesto desde la partida; el
   artefacto del padre no se reaplica. Un padre con LoRA se rechaza.
3. La composición acumula en fp32 y redondea una vez: el caso de 256 + 0,75 + 0,75 da 258, no 256. Dos composiciones del
   mismo genoma dan los mismos resúmenes por módulo.
4. Las tres medidas de tamaño se calculan sobre la intervención compuesta: un cambio de rango 1 que cambia todas las
   entradas de una matriz cuenta todas como cambiadas.
5. El laboratorio rechaza sondas de selección y casos de confirmación, cobra cada consulta y sus tokens, respeta sus
   límites de tiempo, memoria y tamaño, y pasa por la cola del junior.
6. Un constructor repetido con sus entradas da los mismos valores. Una edición `program` se rechaza si no hay backend
   aislado; el sandbox de procesos actual no cuenta como tal.
7. Una búsqueda sin semillas de control se rechaza al configurarse. `perturb` y `reinit` producen material que no estaba
   en los padres, deterministas dada su semilla.
8. El nicho de todo candidato medido se calcula sólo con sondas; un candidato sin medir no ocupa nicho; uno inválido no se
   evalúa y se conserva. La calidad sigue la regla de §6.5, con sus desempates, y un dato ausente nunca cuenta como
   déficit cero.
9. El archivo conserva candidatos de nichos distintos aunque uno domine, y la verificación lo reconstruye sin modelo.
10. Un candidato sólo se promueve con `paired-cases@1` contra la referencia de evaluación, y sólo se anuncia como mejora
    tras la confirmación externa, que declara `edited`.
11. Agotar una bolsa detiene la búsqueda conservando su archivo; un trabajo cortado no se vuelve a cobrar al reanudar.
12. `project_out` con `W = I` y `d = [2, 0]` da `diag(0, 1)`; registra `d̂ = [1, 0]`. Un vector nulo, no finito o de
    dimensión equivocada se rechaza.
13. Un candidato exportado (`lab junior package --export`) se importa en un almacén vacío y se recompone sin acceso al run
    original, con los mismos resúmenes de pesos por módulo; sus constructores se verifican con las entradas que viajan en
    el árbol.

## 14. Revisión externa (04/11/2026)

Conciliada en esta versión:

| Punto | Dónde |
|---|---|
| Sobre qué pesos se acumulan las ediciones; orden de redondeo; partida separada de la referencia; LoRA rechazado | §3.2, aceptación 2–3 |
| El sandbox de procesos no está aislado: constructores cerrados por defecto, programas libres sólo con backend aislado | §4.3, §4.4, WE2 |
| Nichos dependientes de investigaciones; regla de calidad; candidato sin mejora frente a inválido | §6.4, §6.5 |
| Una pasada no limita el trabajo: consultas, tokens, tiempo, memoria y tamaño, en la cola del junior | §4.2, §9 |
| E3 contradecía la selección visible: tres usos de los datos | E3, §4.1, §7 |
| «Pesos tocados» depende de la codificación: tres medidas sobre la intervención compuesta, cotas del manifiesto | §3.3 |
| Mutaciones que introducen material nuevo sin LLM | `perturb`, `reinit` en §6.3 |
| «No añade capacidades» era una conclusión del artículo, no un hecho general | H2 en §1, §8, §11 |

Segunda revisión, el mismo día:

| Punto | Dónde |
|---|---|
| `project_out` sólo quitaba la dirección si `d` era unitaria: se normaliza dentro, con argumentos comprobados | §4.3, aceptación 12 |
| H2 atribuía a la evaluación distinguir desbloquear de construir: ahora mide la transferencia a investigaciones completas | H2 en §1, §8, §11 |
| El exportador no sigue referencias dentro de un JSON: el árbol lleva como ficheros todo lo necesario para componer y verificar | §3.2, WE1, aceptación 13 |

Revisión de la implementación de WE1, el mismo día:

| Punto | Dónde |
|---|---|
| La composición aceptaba NaN (+∞ y −∞ de factores finitos) y la verificación lo daba por bueno: ahora se rechaza lo no finito, y una medida NaN nunca está dentro de una cota | §3.3, `compose` y el trabajador |
| El verificador sólo comparaba los resúmenes de pesos: ahora recalcula todas las medidas y totales, aplica las cotas del conjunto y comprueba `chip_layers` | §3.3, `verifyEditSet` |
| El rango se acotaba por edición: ahora `rank_bound` suma los rangos del módulo, una cota conservadora declarada como tal | §3.3 |
