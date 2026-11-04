# SPEC · Edición de pesos: el modelo fuerte escribe en los pesos del junior, y una búsqueda evolutiva los explora

Estado (04/11/2026): **propuesta, sin implementar**; dos revisiones externas del mismo día conciliadas (§14); lista para desarrollo. Amplía
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
  1. Para cada módulo tocado, se suman en fp32, en el orden del genoma, todos los `ΔW` que lo tocan.
  2. Se aplica una vez: `W' = redondeo_bf16( fp32(W_partida) + ΔW_total )`.
  3. Nunca se aplica una edición sobre pesos ya editados.

El orden importa en bf16: partiendo de 256, dos incrementos de 0,75 dan 256 si se redondea tras cada uno y 258 si se
acumulan primero en fp32. La regla fija el segundo. Tras componer se registra el resumen de los pesos resultantes de cada
módulo tocado; dos composiciones del mismo genoma deben dar los mismos resúmenes.

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

## 4. El laboratorio de pesos

El modelo fuerte necesita observar al junior para proponer ediciones. Lo hace con un instrumento nuevo que corre en la
máquina del junior, en un proceso propio. Sólo lee.

### 4.1 Qué casos puede consultar

El manifiesto declara tres conjuntos de grupos disjuntos (E3): **diagnóstico**, **selección** y **confirmación**. El
laboratorio sólo ejecuta casos de diagnóstico: cortes de runs de desarrollo de esos grupos, o textos escritos por el
propio modelo fuerte. Nunca ejecuta sondas de selección ni casos de confirmación. Las capas del circuito pueden leerse,
para entender, pero nunca editarse.

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
entradas da el mismo `ΔW`; el verificador lo comprueba.

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

Orden de las palancas, de más barata a más cara: prompt, memoria inicial, decodificación, **edición de pesos**,
destilación, LoRA. La edición va antes que la destilación porque no entrena nada. Va después de la memoria porque cambia
pesos y exige pasar la validez.

## 6. La búsqueda evolutiva de juniors

Cuando la palanca individual no basta, una búsqueda explora muchas ediciones a la vez. Usa el motor evolutivo existente
(`lib/src/learn/evolve`) con un candidato nuevo: el **genoma** sobre una partida fija.

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
`refine` es ayuda ajena (E4) y se cuenta aparte en el presupuesto.

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
el investigador adopta o no. Como en las ramas evolutivas existentes, lo que importa es que abra líneas que el
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
