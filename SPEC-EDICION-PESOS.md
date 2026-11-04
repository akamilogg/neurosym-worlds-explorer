# SPEC · Edición de pesos: el modelo fuerte escribe en los pesos del junior, y una búsqueda evolutiva los explora

Estado (04/11/2026): **propuesta, sin implementar**. Amplía [SPEC-METAPOLITICA-APRENDIZAJE](SPEC-METAPOLITICA-APRENDIZAJE.md)
con una palanca nueva de la fase A, entre la memoria inicial y LoRA, y con una búsqueda evolutiva sobre ella. Reutiliza
el [motor evolutivo](SPEC-DELEGACION-EVOLUTIVA.md), las ramas de [delegación](SPEC-DELEGACION-INVESTIGACIONES.md), la
escalera de competencias, las sondas y `paired-cases@1`.

## 1. De dónde sale

[Weight-Space Programming](https://rikiyat.github.io/blog/weight-space-programming/) describe un modelo frontera que lee
y escribe los pesos de una red directamente, sin descenso de gradiente. El resultado que nos concierne es su experimento
8: con 50 pasadas hacia delante, editó el 0,016 % de los pesos de **Qwen3.5-0.8B** (por ejemplo, restando una dirección
de las columnas de salida de una MLP). MATH-500 pasó del 7,9 % al 48,1 %, GSM8K del 13,8 % al 67,1 % e IFEval del 21 % al
62,3 %. Gran parte de la mejora consistió en quitar un obstáculo: las respuestas que agotaban el límite de tokens bajaron
del 93 % al 33 %.

Los propios autores acotan el alcance:

- La edición **quita obstáculos que ocultan una capacidad; no añade una que falte**. Con Gemma 3 270M no hubo mejora.
- Leer el comportamiento sólo de los pesos falló; con acceso a activaciones y patrones de atención, acertó.
- Son resultados tempranos de un solo equipo. No hablan de búsqueda evolutiva ni de que un modelo grande siembre a otros.

Nuestro junior es Qwen3.5-4B con un ordenador compilado delante. Lo que se espera de él en la fase A son justo
obstáculos: formato, peticiones mal formadas, no consultar su memoria, respuestas que no terminan. Esta spec convierte esa
evidencia en **una palanca medible** y en **una fuente de diversidad** para cuando el junior deja de mejorar: el modelo
fuerte propone ediciones como hipótesis, y una búsqueda evolutiva las combina y las varía. Que esta palanca funcione aquí
es la hipótesis que se mide, no una premisa.

## 2. Principios

- **E1. La edición es una hipótesis.** Cada edición declara qué cree que corrige, en qué competencia y por qué, antes de
  medirse. Lo mismo que un `change` del mundo del junior.
- **E2. El circuito no se toca.** Ninguna edición alcanza las capas del ordenador compilado ni sus cabezas DeltaNet. Una
  versión editada pasa la misma validez que una entrenada (SPEC-METAPOLITICA-APRENDIZAJE §10.1) antes de evaluarse.
- **E3. Quien edita no ve lo que selecciona.** El modelo fuerte observa al junior sólo en casos de **diagnóstico**, de
  grupos distintos de los que seleccionan. Si ve las sondas que deciden, la selección queda contaminada.
- **E4. Lo ajeno se declara.** Una edición escrita por el modelo fuerte es ayuda ajena, con su autoría en la procedencia,
  como lo destilado.
- **E5. Todo se reconstruye.** Cada edición es un artefacto por hash, con el programa que la produjo y sus entradas.
- **E6. Sin control no hay conclusión.** Toda comparación de ediciones del modelo fuerte lleva su control: ediciones
  aleatorias del mismo tamaño y en los mismos módulos. Sin ese control no puede distinguirse una edición acertada de una
  perturbación cualquiera.

## 3. La edición como artefacto: `weight-edit@1`

Una edición es un cambio aditivo sobre módulos de Qwen, `W' = W + ΔW`, en una de dos codificaciones:

| Codificación | Qué guarda | Para qué |
|---|---|---|
| `lowrank` | Factores `B` (d_out × r) y `A` (r × d_in) por módulo, `ΔW = B·A` | Restar o añadir direcciones. Restar la dirección `d` de la salida de un módulo es `ΔW = −d·(dᵀW)`, de rango 1 |
| `sparse` | Índices y valores por módulo | Cambios puntuales en unas pocas entradas |

Cada edición incluye además:

- **Módulos e índices de capa**, todos de Qwen. Se rechaza cualquier capa menor que `chip_layers` del paquete.
- **Cotas declaradas:** fracción máxima de pesos tocados y razón máxima entre la norma de `ΔW` y la de `W`, por módulo. Una
  edición fuera de sus cotas se rechaza.
- **Su hipótesis** (E1): competencia, mecanismo supuesto y efecto esperado.
- **Su origen**, uno de estos tres:
  - `written`: los valores escritos directamente por el modelo fuerte;
  - `program`: un programa que calcula la edición a partir de pesos y activaciones. Se guarda el programa, las entradas
    por hash y la salida;
  - `operator`: una edición producida por un operador de la búsqueda (§6.3) a partir de otras, con sus padres.
- **Autoría:** modelo fuerte, búsqueda o control aleatorio.

**Cómo encaja en el paquete.** Una o varias ediciones se combinan en un solo artefacto que ocupa el sitio del adaptador
en `junior-package@1`, como un árbol por hash. El trabajador ya suma un adaptador a los pesos de Qwen en su sitio; aquí
reconoce el formato `weight-edit@1` y aplica cada `ΔW`. Una versión lleva **un** artefacto de pesos, sea LoRA o ediciones:
combinarlos es otra receta, no algo implícito.

**Precisión.** Los pesos se sirven en bf16. La edición se calcula en fp32 y se redondea al aplicarla; el resumen de los
pesos resultantes de cada módulo tocado queda en el registro, para que dos aplicaciones de la misma edición se comprueben
iguales.

## 4. El instrumento de lectura: el laboratorio de pesos

El modelo fuerte necesita observar al junior para proponer ediciones. Lo hace con un instrumento nuevo que corre en la
máquina del junior, en un proceso propio. Sólo lee:

| Operación | Qué devuelve | Coste |
|---|---|---|
| `modules` | La lista de módulos editables, con sus formas | Gratis |
| `weights.stats` | Normas, espectro de los primeros valores singulares y percentiles de un módulo | Gratis |
| `weights.slice` | Un trozo acotado de una matriz (filas y columnas, con un máximo de entradas) | Gratis |
| `forward` | El junior sobre un caso de diagnóstico: tokens generados, sus k primeros logits por posición y la razón de parada | Una pasada |
| `activations` | Normas y direcciones principales de la salida de unos módulos, en unas posiciones de un caso de diagnóstico | Una pasada |
| `attention` | Patrones de atención resumidos de unas cabezas en un caso de diagnóstico | Una pasada |
| `try` | Lo mismo que `forward`, con una edición candidata aplicada en una copia | Una pasada |

**Qué puede consultar.** Sólo **casos de diagnóstico** (E3). Son cortes de runs de desarrollo de grupos que el
manifiesto declara como `diagnosis`, disjuntos de los de selección. Nunca las sondas que seleccionan ni casos de
confirmación. Las capas del circuito pueden leerse, para entender, pero nunca editarse.

**Cuánto puede consultar.** Las pasadas salen de su propia bolsa, `forward_passes`. El artículo usó 10, 25 y 50 pasadas
por intento; aquí el tope es por edición y lo fija el manifiesto.

**Qué queda registrado.** Cada consulta y su respuesta, como un recibo del servidor del junior.

**Programas.** Una edición de origen `program` corre en el sandbox de procesos del arnés, con los pesos de solo lectura y
las respuestas de sus consultas como entradas. No tiene red ni acceso a ficheros fuera de su carpeta. Repetirlo con las
mismas entradas debe dar el mismo `ΔW`; el verificador lo comprueba.

## 5. La palanca en el mundo del junior

Se añaden dos actos a `junior-competence@1`:

- **`inspect_weights`**: consulta el laboratorio de pesos (§4). Devuelve un episodio de lecturas y lo paga de
  `forward_passes`.
- **`edit`**: crea una versión hija con una edición. Lleva:
  - la versión de origen;
  - la edición, o el programa que la produce;
  - su hipótesis y lo que espera (como un `change`).

Antes de evaluarse, la versión pasa la validez del circuito. Cada edición se paga de su propia bolsa, `edits`.

Las versiones editadas se miden, se comparan y se promueven como cualquier otra: escalera, sondas de selección,
investigaciones y `paired-cases@1` contra la referencia. Se confirman igual, fuera de la máquina (MA6). En la
confirmación, el resumen declara `edited` junto a `distilled` y `trained`.

Orden de las palancas, de más barata a más cara: prompt, memoria inicial, decodificación, **edición de pesos**,
destilación, LoRA. La edición va antes que la destilación porque no entrena nada. Va después de la memoria porque cambia
pesos y exige pasar la validez.

## 6. La búsqueda evolutiva de juniors

Cuando la palanca individual no basta, una búsqueda explora muchas ediciones a la vez. Usa el motor evolutivo existente
(`lib/src/learn/evolve`) con un candidato nuevo: el **genoma**.

### 6.1 Genoma

Un genoma es una lista ordenada de ediciones `weight-edit@1`. Su fenotipo es el paquete con todas ellas combinadas.

- Dos genomas con las mismas ediciones son el mismo candidato, por hash.
- Un genoma también declara su rango y su número de ediciones. Las cotas totales se suman, y un genoma que las exceda se
  rechaza antes de evaluarse.

### 6.2 Semillas

La población inicial tiene tres orígenes, en proporciones fijadas por el manifiesto de la búsqueda:

- **Semillas del modelo fuerte.** Las propone después de diagnosticar los fallos de la línea base en casos de diagnóstico.
  Se le pide un número fijado de hipótesis **distintas** (mecanismos o módulos diferentes), no variantes de una sola:
  la diversidad empieza aquí.
- **Semillas de control aleatorio** (E6). Direcciones aleatorias con la misma norma, en los mismos módulos y con el mismo
  rango que las semillas del modelo fuerte. Sin ellas no se sabe si las hipótesis del modelo fuerte aportan algo.
- **El genoma vacío**, que es la referencia.

### 6.3 Operadores

| Operador | Qué hace | Quién lo aplica |
|---|---|---|
| `refine` | Lee los fallos de un candidato en casos de diagnóstico y propone una edición que lo corrija o lo complemente | El modelo fuerte, con sus pasadas |
| `scale` | Multiplica una edición por un factor | Código |
| `drop` | Quita una edición del genoma | Código |
| `combine` | Une las ediciones de dos genomas | Código |
| `retarget` | Mueve una edición a la capa vecina del mismo tipo | Código |
| `sparsify` | Pone a cero las entradas más pequeñas de una edición `sparse` | Código |

Los operadores de código son deterministas dada su semilla, y cada hijo guarda sus padres y el operador que lo produjo.
`refine` es ayuda ajena (E4) y se cuenta aparte en el presupuesto.

### 6.4 Evaluación en cascada

Evaluar un junior es caro, así que cada candidato pasa por filtros de menor a mayor coste. Se detiene en el primero que
no supera:

1. **Cotas y validez del circuito** (§3, E2). Sin inferencia más allá de la suite de validez.
2. **Sondas de selección**, con el número de respuestas de la regla de §6.3 de la spec base. Es la medida principal de la
   búsqueda.
3. **Investigaciones completas**, sólo para las élites (los mejores de cada nicho, §6.5).
4. **Confirmación externa**, sólo para el candidato que se quiere promover, fuera de la máquina.

Cada paso es un trabajo del libro, con su reserva. Un candidato cortado en el paso 2 sigue en el registro con lo medido:
puede ser padre de otros.

### 6.5 Diversidad

La búsqueda no conserva sólo el mejor vector. Mantiene un **archivo por nichos**, al estilo MAP-Elites, con el mejor
candidato de cada nicho. El nicho de un candidato se define por dos descriptores, fijados en el manifiesto de la búsqueda
antes de empezar:

- **Qué componentes mejora**: el signo de su diferencia con la referencia en cada componente de la escalera (mejora, igual,
  empeora).
- **Dónde actúa**: el grupo de capas y el tipo de módulo que más tocan sus ediciones.

Así, una edición que arregla las peticiones y otra que arregla el protocolo conviven, aunque ninguna supere a la otra en
todo. Esa convivencia es la diversidad que se busca cuando el junior se atasca: formas distintas de trabajar, no sólo
versiones del mismo arreglo.

### 6.6 Cuándo se abre

La búsqueda se abre de una de tres formas:

- **El investigador fuerte la pide**, con el acto `evolve` del mundo: fija la versión de partida, el presupuesto y los
  descriptores.
- **El arnés la propone por atasco.** Si en K evaluaciones seguidas ninguna versión se promueve y los déficits no se
  mueven, el mundo avisa por el canal de mensajes de que puede abrir una búsqueda. No la abre por su cuenta: decidir sigue
  siendo del investigador.
- **El operador la lanza** como rama de delegación, con su propio fondo.

Lo que devuelve son versiones con su procedencia completa (genoma, padres, operadores y autoría), que el investigador
adopta o no. Como en las ramas evolutivas existentes, lo que importa es que abra líneas que el investigador no tenía, no
que su primer resultado se promueva.

## 7. Medida y promoción

- Un candidato de la búsqueda se promueve igual que cualquier versión: `paired-cases@1` contra la referencia, con las
  tolerancias de los componentes protegidos. La búsqueda **no** se promueve contra su propio mejor candidato.
- Las sondas de selección son desarrollo visible. Un candidato elegido mirándolas muchas veces puede sobreajustarse a
  ellas. Por eso la confirmación externa es obligatoria antes de anunciar una mejora. La búsqueda declara cuántas
  evaluaciones hizo sobre las mismas sondas, y el manifiesto puede limitar ese número.
- **La retención** se mide con los componentes protegidos y con la suite de validez. Una edición puede romper capacidades
  ajenas a la que corrige: eso es una regresión, no un detalle.

## 8. La comparación que dice si sirve

La hipótesis del artículo, que la edición quita obstáculos pero no añade capacidades, se pone a prueba aquí con
condiciones fijadas antes de empezar, desde la misma línea base y con el mismo presupuesto total:

| Condición | Qué se hace |
|---|---|
| A | Sin cambios de pesos: prompt, memoria y decodificación |
| B | Ediciones del modelo fuerte, una a una (§5) |
| C | Ediciones aleatorias de control, del mismo tamaño (E6) |
| D | Búsqueda evolutiva con semillas del modelo fuerte (§6) |
| E | Búsqueda evolutiva sólo con semillas aleatorias |
| F | Destilación y LoRA (MA4, MA5) |

Lo que se lee de cada condición:

- **Qué componentes** mejoran: se espera más en los peldaños de obstáculos (protocolo, peticiones, reglas) que en el de
  mundos resueltos.
- **Cuánto cuesta** cada mejora: tokens del modelo fuerte, pasadas y horas de GPU.
- **Cuántas líneas distintas** abre la búsqueda: nichos ocupados.
- **Si B supera a C y D a E.** Si no, las hipótesis del modelo fuerte no aportan más que el azar, y eso también es un
  resultado.

## 9. Presupuesto

Se añaden dos bolsas a las de la spec base:

- **`forward_passes`**: las pasadas del laboratorio de pesos (§4) y los `try`.
- **`edits`**: versiones editadas creadas.

Las evaluaciones siguen saliendo de `evaluations`, y los tokens del modelo fuerte (diagnóstico, semillas, `refine`) de
su bolsa. Una búsqueda reserva antes de empezar el máximo que puede gastar de cada bolsa y se detiene al agotarlo,
conservando su archivo.

## 10. Registro y reconstrucción

Se reconstruyen sin modelo:

- cada edición, desde sus valores o desde su programa y sus entradas;
- cada genoma, desde sus padres y operadores;
- cada evaluación, desde sus recibos;
- el archivo de la búsqueda, desde su registro.

`lab verify` de una búsqueda comprueba que cada candidato del archivo es el que dicen sus operadores y que su posición en
el archivo corresponde a sus medidas.

## 11. Límites

- **La evidencia de partida es débil.** Es un artículo temprano, con un modelo frontera concreto y otro tamaño del
  junior. Si en nuestras condiciones no reproduce, la palanca se queda como opción probada y descartada.
- **Un 4B no es un 0,8B, y lleva un ordenador delante.** Las direcciones que importan pueden ser otras, y la cercanía al
  circuito exige cuidado extra en la validez.
- **No añade capacidades** (según el propio artículo). Si al junior le faltan, ni editar ni buscar las crean: eso
  correspondería a la destilación y al entrenamiento.
- **El modelo fuerte necesita contexto largo** para leer pesos y activaciones. Las respuestas del laboratorio se resumen
  y se acotan para que quepan.
- **El sobreajuste a las sondas** se mitiga, pero no se elimina, con la confirmación externa y el tope de evaluaciones.

## 12. Entregas

| Etapa | Depende de | Entrega |
|---|---|---|
| **WE1 · El artefacto** | MA5 | `weight-edit@1` (`lowrank`, `sparse`), cotas, combinación en un artefacto, aplicación en el trabajador y validez del circuito |
| **WE2 · El laboratorio de pesos** | WE1, MA2 | Lecturas, pasadas con su bolsa, partición de diagnóstico disjunta de la selección, programas en el sandbox con verificación |
| **WE3 · La palanca** | WE2 | Actos `inspect_weights` y `edit` en `junior-competence@1`; `edited` en la confirmación |
| **WE4 · La búsqueda** | WE3 | Genoma, semillas del modelo fuerte y de control aleatorio, operadores, evaluación en cascada, archivo por nichos; acto `evolve` |
| **WE5 · El atasco** | WE4 | Aviso por el canal cuando el junior se estanca; la búsqueda como rama de delegación |
| **WE6 · La comparación** | WE4, primera línea base real | Las condiciones A–F de §8, lanzadas por el operador |

**WE1 a WE5 se prueban con el driver de imitación** (`lib/test/fixtures/fake-driver`) y modelos sustitutos. **WE6
necesita la máquina real y la línea base de la fase A**: no tiene sentido buscar ediciones contra obstáculos que aún no se
han medido.

## 13. Aceptación

1. Una edición en capas del circuito, fuera de sus cotas o sin hipótesis se rechaza antes de crear la versión.
2. Aplicar la misma edición dos veces da los mismos pesos, comprobado por el resumen de cada módulo tocado. Una edición
   de programa, repetida con sus entradas, da el mismo `ΔW`.
3. Una versión editada que altera el resumen de los parámetros del circuito no se evalúa.
4. El laboratorio de pesos rechaza consultas sobre sondas de selección o casos de confirmación, y cobra cada pasada de
   su bolsa.
5. Una búsqueda sin semillas de control se rechaza al configurarse.
6. El archivo conserva candidatos de nichos distintos aunque uno domine en el vector, y `lab verify` lo reconstruye sin
   modelo.
7. Un candidato de la búsqueda sólo se promueve con `paired-cases@1` contra la referencia, y sólo se anuncia como mejora
   tras la confirmación externa, que declara `edited`.
8. Agotar una bolsa detiene la búsqueda conservando su archivo. Un trabajo cortado no se vuelve a cobrar al reanudar.
