# SPEC · Un mundo 3D en Blender: partículas bajo fuerzas que nadie le ha contado

Estado (30/09/2026): **B0–B5 hechos** (§7, §10); falta B6, los experimentos con LLM real.

Se lanza con dos procesos, el servicio de Blender y el laboratorio; el visor es aparte:

```
node --experimental-strip-types scripts/particles3d-service.ts --port 18500
node --experimental-strip-types scripts/run-particles3d.ts --seed 1 --level 1 --condition A
node --experimental-strip-types scripts/particles3d-view.ts runs/<journal>.json --episode ep1 --from 4
```

Decisiones del autor (30/09/2026):

- **Una ley interpretable**, no un predictor opaco.
- **Percepción por tablas** de coordenadas; las imágenes quedan para después.
- **Con caos:** hay regímenes donde predecir lejos es imposible incluso con la ley correcta.
- **Todo en Blender**, incluida la condición de control.

Parte de lo que ya existe:

- orbit@1 (SPEC-MUNDO-FISICO): leyes descubiertas desde tablas, intervenciones con `act`, familia de montajes,
  confirmación ciega y un veredicto por punto;
- el laboratorio externo `tank@1` (O12): un servicio en otro proceso, peticiones con clave de idempotencia y respuestas
  grabadas;
- la verdad oculta opcional (decide la validación por familia);
- el investigador de mundo desconocido, sin cambios.

## 1. Motivación

Orbit mostró que el investigador, con tablas e intervenciones, descubre una ley de potencia distorsionada, la corrige y
aprende la superposición cuando la validación falla. Este mundo le exige más a la vez:

- **3D y muchas partículas.**
- **Varias fuerzas superpuestas,** con fuentes invisibles cuya posición hay que inferir.
- **Fuerzas que no dependen sólo de la posición:** rozamiento, fuerzas perpendiculares a la velocidad, vórtices.
- **Propiedades ocultas por partícula** (masa, carga con signo) que sólo se ven en cómo se mueve cada una.
- **Interacciones entre partículas.**
- **Caos:** un horizonte más allá del cual nadie puede predecir.

Y abre una pregunta nueva: **el uso del conocimiento previo.** System 2 no sabe que el mundo es Blender. Sólo lo ve a
través de nuestra capa: tablas, `act` y su propio código. Si lo reconoce, será un descubrimiento suyo a partir de la
evidencia. Lo que interesa medir es cómo lo usa:

- como una hipótesis que pone a prueba;
- o como una verdad que proyecta sin comprobar.

## 2. Principios

- **M1. Nadie le dice qué es el mundo.**
  - Ni el motor, ni los nombres de los campos, ni las unidades.
  - Los ejes y las escalas de cada escena se giran y se escalan, para que ni «la gravedad va en −Z» ni «9,81» delaten
    el motor.
  - Si reconoce Blender, lo hace por cómo responde el mundo.
- **M2. El mundo es lo que Blender hace.**
  - El integrador, los subpasos y la amortiguación forman parte del mundo que hay que descubrir; no son un error que
    corregir.
  - No hay una ley oculta nuestra que haga de verdad: decide la validación por familia y la confirmación ciega. La
    definición de la escena existe y el operador la usa para calificar, pero nunca es el criterio.
- **M3. La respuesta es una ley legible.**
  - Código que, dado el historial de filas, responde la fila siguiente.
  - Aplicada sobre sus propias predicciones, da la trayectoria a varios pasos.
  - Las propiedades ocultas las infiere la ley desde el historial; si necesita un integrador, lo lleva dentro, como hizo
    el run 2 de orbit.
- **M4. Predecir hasta donde se puede.**
  - El criterio mide por horizontes, y la vara de medir es la predictibilidad del propio mundo (§5.2).
  - En un régimen caótico no se pide lo imposible. Se mide si el investigador reconoce el límite en vez de parchear.
- **M5. El conocimiento previo es una referencia, no una verdad.**
  - Igual que las fuentes del asistido: reconocer un motor o una fórmula es una hipótesis, que vale si resiste los
    experimentos.
  - El operador mide si la pone a prueba (§6).
- **M6. Los mismos invariantes de siempre.**
  - Sin análisis precocinado: el entorno da un veredicto por punto, nunca estadísticos agregados.
  - Sin métrica para System 2.
  - Todo queda en el journal y en la grabación.

## 3. El mundo

### 3.1 Qué hay en una escena

- **Partículas:** de 1 a N. Cada una tiene propiedades ocultas según el nivel (masa, carga, radio).
- **Fuentes de fuerza invisibles:** posición, orientación, forma y parámetros elegidos por la semilla.
- **Ajustes del motor:** paso de tiempo, subpasos, amortiguación. Son fijos dentro de una familia.

La semilla genera la escena. La **familia** conserva las leyes y los ajustes del motor y cambia lo demás:

- posiciones de las fuentes;
- número de partículas y condiciones iniciales;
- giro y escala de los ejes.

### 3.2 Percepción

- **Tablas** de posiciones 3D por fotograma de las partículas seguidas, como en orbit.
- Sin velocidades, propiedades ni nombres; cada partícula tiene una etiqueta neutra (`p1`, `p2`...).
- Opciones del operador:
  - ruido de medida;
  - resolución;
  - submuestreo de fotogramas;
  - partículas no seguidas (observación parcial).

### 3.3 Intervenciones (`act`)

- `launch`: añadir partículas sonda con posición y velocidad elegidas.
  - `like: "p3"` copia las propiedades ocultas de una partícula ya vista. Así se puede intervenir sobre lo oculto sin
    revelarlo.
- `release`: soltar en reposo.
- `rerun`: repetir un episodio desde un fotograma con un cambio.
- Todo con presupuesto por ronda, como en orbit.

### 3.4 Niveles

| Nivel | Lo que hay que descubrir |
|---|---|
| 1 | un campo sobre partículas que no interactúan; forma, caída y potencia elegidas por la semilla |
| 2 | varios campos superpuestos, con fuentes invisibles que hay que localizar |
| 3 | fuerzas que dependen de la velocidad: rozamiento lineal o cuadrático, fuerza perpendicular al movimiento, vórtice |
| 4 | propiedades ocultas por partícula (masa, carga con signo) que hay que inferir |
| 5 | interacción entre partículas: muchos cuerpos, atracción y repulsión según la distancia |
| 6 | caos: interacciones fuertes, turbulencia determinista por semilla; un horizonte de predicción finito |

### 3.5 Condiciones (el conocimiento previo)

Se declaran de antemano y los runs se comparan sólo dentro de cada condición (P6).

| Condición | Escenas | Qué mide |
|---|---|---|
| **A · reconocible** | campos nativos de Blender con parámetros por defecto | si reconoce el motor o las fórmulas, cuándo, y si eso le acelera o le engaña |
| **B · distorsionada** | los mismos campos con parámetros raros (potencias de caída no habituales, formas, ruido) | si abandona el prior cuando los datos no encajan |
| **C · inventada** | campos cuya fuerza no responde a ninguna fórmula de libro: el gradiente de una textura procedural (nubes, Voronoi, mármol...) y caídas en forma de tubo o cono, integrados por el mismo motor | el rendimiento sin nada que reconocer |

## 4. Arquitectura

- **El servicio.** Un proceso Blender persistente, en modo headless (`blender -b --python service.py -- --port N`), que no
  paga el arranque en cada petición. Sigue el patrón de `tank@1`:
  - `POST /scene {seed, level, condition, place}`: crea una escena y devuelve su id;
  - `POST /episode {scene, ...}`: simula y devuelve la tabla de posiciones;
  - `POST /act {scene, act}`: lanza, suelta o repite, y devuelve la tabla;
  - cada petición lleva su clave de idempotencia, como en `tank@1`;
  - escucha sólo en `127.0.0.1`.
- **El laboratorio,** `particles3d@1`, en TypeScript y con el contrato `Lab`. Es un laboratorio externo (`external.url`):
  - convierte las tablas del servicio en lo que percibe System 2, con los ejes girados y escalados;
  - valida los `act`;
  - comprueba la ley con el criterio de §5.
- **La grabación.** Cada respuesta del servicio queda en el log (canal `env`). Una reanudación no depende de que Blender
  repita exactamente, sólo de que una escena sea estable dentro de un run.
- **El visor para el humano.** El servicio puede devolver un `.blend`, o una animación, con las trayectorias reales y las
  que predice la ley aceptada, para verlas en 3D. Es interpretabilidad para el operador; System 2 nunca lo ve.

## 5. El criterio

### 5.1 Por horizontes

La ley se comprueba en puntos de comprobación, cada uno a varios horizontes:

- **Un paso:** desde el historial real, la fila siguiente.
- **h pasos:** aplicada sobre sus propias predicciones, la fila h pasos después, para varios h hasta el horizonte de
  referencia (§5.2).

El veredicto por punto y horizonte es un hecho, como en orbit: el error relativo por eje en [−1, 1], sin agregados.
La aceptación sigue el protocolo de siempre: laboratorios, validación en la familia y confirmación ciega doble.

### 5.2 La predictibilidad del propio mundo (sólo el operador)

Para cada escena, el servicio repite la simulación con las condiciones iniciales perturbadas al nivel del ruido de
percepción. El fotograma en que las trayectorias perturbadas se separan más allá de la tolerancia es el **horizonte de
referencia** H\*: hasta ahí podría predecir cualquiera que conociera la ley exacta.

- El criterio pide acierto hasta una fracción de H\* (por ejemplo, el 80 %), nunca más allá.
- En los niveles 1 a 5, H\* es largo y la ley debe predecir lejos.
- En el nivel 6, H\* es corto. Aceptar exige predecir bien hasta H\*, no más.
- Operador: si el investigador **reconoce el límite**, en sus notas y creencias, o intenta parchear más allá.

System 2 nunca ve H\*. Si quiere saber hasta dónde se puede predecir, tiene que descubrirlo, por ejemplo lanzando dos
sondas casi iguales con `like`.

## 6. Medidas del operador

System 2 no ve nunca ninguna de estas medidas.

- **Recuperación de la ley:** el grader la compara con la definición de la escena (qué campos, qué formas, qué
  propiedades). Separa predecir de entender, como en `cells` y orbit.
- **Uso del conocimiento previo:**
  - si nombra un motor, un campo o una fórmula conocida, en qué ronda y con qué evidencia;
  - si lo pone a prueba con experimentos, o lo asume;
  - si le ahorra coste hasta la aceptación, o le lleva a una ley equivocada que tiene que desandar;
  - todo comparado entre las condiciones A, B y C.
- **Caos:** si reconoce el horizonte y cómo lo mide.
- **Coste:** llamadas y tokens en total y hasta aceptar; tiempo de simulación.
- **Jev:** su papel se espera pequeño, porque lo numérico lo resuelve el código (lo vimos en orbit). La ablación lo mide
  igualmente.
- **Comprobaciones triviales:** líneas base que no saben nada (la partícula sigue recta, repetir el último paso), como en
  orbit.

## 7. Plan

| Fase | Contenido | Criterio de éxito |
|---|---|---|
| B0 (hecho) | **Prueba técnica** de qué mecanismo de Blender usar: el sistema de partículas con campos de fuerza, cuerpos rígidos (Bullet) con campos, o nodos de geometría con una zona de simulación. Versión de Blender fijada | un mecanismo que (1) permita fijar el estado inicial de cada partícula y sus propiedades ocultas, (2) tenga los campos nativos que piden las condiciones A y B y admita fuerzas propias para C, (3) devuelva posiciones por fotograma, (4) sea estable dentro de un run y (5) corra headless en Windows a una velocidad usable |
| B1 (hecho) | Servicio y laboratorio, nivel 1, condición A; tests con el LLM falso (grabación, reanudación, idempotencia) | un run falso cortado y reanudado igual al entero; ninguna simulación repetida sin necesidad |
| B2 (hecho) | El criterio por horizontes y H\*; familia y confirmación ciega; líneas base | una ley falsa hecha a medida se rechaza en la familia; H\* medido y estable por escena |
| B3 (hecho) | Niveles 2 a 5 y las condiciones B y C | cada nivel, generado por semilla, con una ley de referencia que se sostiene y líneas base que no |
| B4 (hecho) | Nivel 6, el caos | H\* corto y medido; la ley de referencia acepta hasta H\* y no más allá |
| B5 (hecho) | El visor en Blender para el humano | la ley aceptada y la realidad, juntas en 3D |
| B6 | Experimentos | §8 |

## 8. Evidencia que la sostendría

- **Descubrimiento:** ¿recupera la ley en los niveles 1 a 5, con réplicas y varias semillas? ¿Qué nivel es el techo?
- **Conocimiento previo:**
  - En A, ¿reconoce el motor? ¿Lo contrasta?
  - En B, ¿abandona las fórmulas por defecto cuando no encajan? ¿Cuánto le cuesta?
  - Frente a C, ¿cuánto aporta el prior cuando acierta y cuánto cuesta cuando engaña?
- **Caos:** en el nivel 6, ¿reconoce el horizonte y lo mide por su cuenta, o parchea?
- **Instrumentos:** línea base con `--tools none`, como en los demás mundos.
- **Interpretabilidad:** ¿la ley aceptada se entiende al verla contra la realidad en el visor?

## 9. Preguntas abiertas

1. **El mecanismo de Blender** (B0). Cada uno tiene límites que hay que comprobar antes de comprometerse:
   - control del estado inicial por partícula;
   - campos disponibles;
   - interacción entre partículas;
   - estabilidad;
   - velocidad.
2. **Tamaño de las tablas.** Con muchas partículas y fotogramas, lo percibido no cabe en el contexto. Probablemente
   haya que servir las tablas bajo demanda (`view` por partículas y rango), como el resto de instrumentos.
3. **Las condiciones A y B frente al giro de ejes.** Girar y escalar protege contra pistas triviales, pero también quita
   parte de lo reconocible en A. ¿Se gira también en A, o A se deja «tal cual» para medir el reconocimiento puro?
4. **Unidades del tiempo.** ¿Se muestra el paso entre fotogramas, o también tiene que descubrirlo?
5. **Ley legible con propiedades ocultas.** Inferir la masa o la carga desde el historial dentro de la ley puede dar
   código difícil de leer. ¿Debe la respuesta separar «ley» y «propiedades inferidas por partícula»?
6. **Imágenes renderizadas.** Después de las tablas: el mismo mundo percibido por imágenes, con percepción y ley a la vez.

## 10. Lo implementado (30/09/2026)

### 10.1 B0: el mecanismo

Blender 3.3.1, que es la versión instalada. No tiene zonas de simulación en nodos de geometría (llegaron en la 3.6).

- **Mecanismo:** el sistema de partículas clásico, con **un emisor de un vértice por partícula**: una sola partícula, emitida
  en su fotograma con la velocidad pedida. Así el estado inicial de cada partícula es exacto, y sus propiedades ocultas
  son las del emisor (masa, y un campo propio `CHARGE` o `LENNARDJ`).
- **Comprobado:**
  - todos los campos que piden los niveles responden (`FORCE`, `HARMONIC`, `WIND`, `VORTEX`, `MAGNET`, `DRAG`, `CHARGE`,
    `LENNARDJ`, `TURBULENCE`, `TEXTURE`);
  - `DRAG` y `MAGNET` dependen de la velocidad;
  - las cargas de las partículas se atraen o se repelen según el signo;
  - `CHARGE` y `LENNARDJ` como campos de objeto sólo actúan sobre partículas cargadas;
  - la masa divide la fuerza;
  - una partícula puede nacer en un fotograma posterior;
  - la misma escena da el mismo resultado;
  - 8 partículas y 200 fotogramas en unos 150 ms.
- **Lo que no se puede:** aplicar fuerzas desde Python en cada paso (el sistema clásico calcula con su caché). Por eso la
  condición C usa campos de textura, cuya fuerza no corresponde a ninguna fórmula de libro. La distancia mínima de los
  campos propios de las partículas no tiene efecto.

### 10.2 El servicio (`lib/blender/particles_service.py`)

- Blender en modo headless y persistente, escuchando sólo en `127.0.0.1`.
- **Sin estado:** cada `POST /simulate` describe la escena entera (motor, campos, partículas) y recibe las posiciones de
  cada fotograma. La clave de idempotencia se acepta y se ignora, porque la misma escena da la misma respuesta.
- **Salidas de escena:** una partícula que se aleja más de `bound` (100 veces la caja), o cuyos números se desbordan, ha
  salido de la escena y es `null` desde entonces. Con cargas fuertes, un encuentro cercano puede lanzarla lejos: es lo
  que hace Blender (M2).
- `scripts/particles3d-service.ts` lo arranca. Busca Blender en `BLENDER`, luego en las rutas habituales.

### 10.3 El laboratorio (`lib/src/worlds/particles3d/`)

- **`scene.ts`**
  - Genera la escena por semilla, nivel y condición.
  - La familia conserva los tipos y parámetros de los campos, el motor y el marco. Cambia la posición de las fuentes y el
    origen de la tabla y, desde el nivel 4, vuelve a sortear las propiedades ocultas.
  - La condición A es **Blender tal cual**: sin giro ni escala, el paso de tiempo de Blender, el integrador por defecto
    (midpoint) y los campos sin caída. Esto responde a la pregunta abierta 3: A mide el reconocimiento puro.
  - B y C giran, escalan y desplazan los ejes, eligen una unidad de tiempo, y sortean el integrador, los subpasos, la
    amortiguación y el rozamiento.
  - El nivel 6 tiene 8 partículas con cargas fuertes, un muelle fuerte que las mantiene juntas, turbulencia y
    episodios de 240 filas.
- **`world.ts`**
  - La tabla: el tiempo, luego x, y, z por columna.
  - Las columnas tienen nombres neutros (letras) y van en orden alfabético, marcadores y partículas mezclados.
  - Hay ruido gaussiano de percepción (`--noise`, relativo a la caja).
  - El código del aprendiz recibe `p = { t, names, series }`.
- **`objective.ts`**, el criterio por horizontes (§5.1):
  - Horizontes: 1, 4, 12 y 30 filas, desde las propias respuestas de la ley.
  - El término de un punto es `|obs − resp|² / (3σ²(1 + (h+1)² + h²) + (ε·|obs − último paso repetido|)²)`, la media
    sobre las partículas. Es el ruido que una ley que conoce el mundo arrastra desde las dos últimas filas: su término
    vale ≈ 1.
  - Se acepta si la mediana por horizonte es ≤ `--accept` (por defecto 2).
  - σ² se estima de los marcadores, que no se mueven.
- **H\* (§5.2)**
  - Por cada episodio de comprobación, el servicio simula otra vez con las posiciones iniciales desplazadas lo que
    difumina la percepción.
  - H\* es el primer fotograma en que alguna partícula difiere más del 2 % de la caja, o en que existe en una
    simulación y no en la otra.
  - Sólo se piden los horizontes ≤ 0,8·H\*.
  - Medido con Blender, seeds 1 a 3:
    - niveles 1 a 5: H\* completo (90 filas), salvo algunos episodios de la condición C (campos de textura) y del
      nivel 3;
    - nivel 6: horizonte finito en parte de los episodios (45 a 57 filas en A y B), y completo en el resto.
- **Operador**
  - El journal guarda los horizontes pedidos en cada comprobación y las palabras de un motor conocido o de física de
    libro que aparecen en la ley (`prior_words_in_law`; `priorWords`).
  - El grader califica frente a la escena, descrita en palabras.
  - Todavía no hay ablación de Jev: aquí se espera una ley en código.

### 10.4 El visor (`scripts/particles3d-view.ts`)

Toma un journal y un episodio de exploración, aplica la ley final desde una fila sobre sus propias respuestas, y guarda un
`.blend` con las trayectorias reales en gris, las de la ley en naranja y los marcadores como esferas, en las coordenadas
de Blender.

### 10.5 Tests (`test/particles3d.test.ts`)

- Escenas, familia, marco y percepción.
- **Criterio en un mundo de dinámica conocida:** un sustituto de Blender que integra `FORCE`. La ley que lo conoce se
  acepta; el último paso repetido no.
- **Grabación:** un run cortado y reanudado sale igual al entero, sin volver a pedir a Blender lo que ya respondió.
- **Con el Blender real** (se salta si no está instalado): un run del nivel 3 condición B, de la exploración a las
  comprobaciones por horizontes.
- **Prompt:** el del investigador puro para este mundo queda congelado en `control.test.ts`, y se comprueba que System 2
  nunca lee la palabra «Blender».
