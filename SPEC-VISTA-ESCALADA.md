# SPEC · Vista de escalada: varios investigadores subiendo la misma montaña

Estado (28/10/2026): **VE1 a VE6 implementados (§13.1 a §13.3)**.

Amplía el Observatorio de [SPEC-CONSOLA-INVESTIGACION](SPEC-CONSOLA-INVESTIGACION.md) con una vista nueva. Lee los
registros de [investigación paralela](SPEC-INVESTIGACION-PARALELA.md), [delegación](SPEC-DELEGACION-INVESTIGACIONES.md),
[búsqueda evolutiva](SPEC-DELEGACION-EVOLUTIVA.md), [mundo vivo](SPEC-ACONTECIMIENTOS-DEL-MUNDO.md) y
[orquestador](SPEC-ORQUESTADOR.md). No cambia a ningún investigador ni su método.

Inspiración: la animación de ocho trabajadores de
[local-autoresearch](https://github.com/conglu1997/local-autoresearch) (`tools/render_progress_gif.py`,
`tools/team_report.py`, licencia MIT). Se toma la idea, no el código.

## 1. La idea

**Cada investigador es un escalador. La métrica del mundo es la montaña y mejorar es subir.** En una sola imagen se ve
quién trabaja, hasta dónde ha llegado cada uno, cuál es la cresta del grupo, dónde se quedó alguien en una meseta, qué le
llegó de los demás y qué hacía en cada momento.

La métrica es el terreno de la investigación, no un sospechoso: sin un resultado que mejora o empeora no se aprende nada.
Por eso ocupa el eje principal. El método va al lado, como marcas sobre cada escalador, nunca en lugar de la métrica ni
fundido con ella en una nota.

Lo que aporta frente a la Trayectoria por rondas (§4.3 de la consola):
- **Varios investigadores a la vez** en el mismo plano, en lugar de una tira por run.
- **El tiempo real de investigación** (reloj o tokens) como eje común, en lugar de rondas que no son simultáneas entre runs.
- **La animación:** en vivo mientras se investiga, y como reproducción acelerada de una investigación terminada,
  reconstruida sólo con sus registros.

## 2. Lo que se ve

| Elemento | Qué es | Origen en el registro |
| --- | --- | --- |
| **Escalador** | Un icono por investigador, en su última muestra de la métrica | Sus checks (§3) |
| **Senda** | Línea fina escalonada con la historia de cada escalador | Las mismas muestras, en orden |
| **Cresta** | Línea gruesa con lo mejor alcanzado por el grupo hasta cada momento | El máximo, en la dirección de mejora, de las sendas |
| **Cumbre** | Marca sobre la senda cuando el protocolo acepta | `accepted`, `artifact_accepted` |
| **Meseta** | Tramo sombreado donde una senda no mejora | Las muestras; y, si existe, la señal de estancamiento del mundo vivo |
| **Estado del escalador** | Forma o color del icono: observa, actúa, espera, delega, propone, comprueba, cierra ronda, parado | Las trazas K4 (`processTraces`, `livingTraces`) |
| **Cuerdas** | Enlaces entre escaladores | §5 |
| **Acontecimientos** | Bandas verticales en el tiempo | §6 |
| **Cabecera** | Cumbre del grupo con su unidad, reloj de investigación y una barra de recursos por escalador | §7 |

La cresta es el mejor resultado *del grupo* hasta cada momento. Sólo es un punto de partida común si los investigadores
lo comparten de verdad (mensajes, tablón, ramas). En local-autoresearch todos parten del mejor programa compartido; aquí
la vista nunca da a entender una comunicación que no existió (C5 de la consola).

## 3. La métrica: un contrato por mundo

### 3.1 Declaración

Cada laboratorio declara sus métricas de progreso con una función opcional nueva, `Lab.progress`, que lee del registro y
nunca ejecuta nada:

```ts
readonly progress?: {
  /* Las métricas del mundo; cada una es una montaña distinta. */
  readonly metrics: readonly {
    readonly id: string;                       // "exact_share", "growth_exponent", ...
    readonly label: string;                    // en palabras del operador
    readonly unit: string;
    readonly direction: 'higher' | 'lower';    // qué es mejorar
    readonly range?: readonly [number, number];
    readonly scale?: 'linear' | 'log';
    readonly source: 'check' | 'artifact_check' | 'validation';
  }[];
  /* El valor de una métrica en un evento del diario, o null si ese evento no la da. */
  sample(metric: string, event: Record<string, unknown>): number | null;
};
```

- **Por defecto,** si un laboratorio no declara nada: la proporción de sus laboratorios donde el modelo se sostiene en
  cada check (más alto es mejor, de 0 a 1). Es grosera pero honrada; un mundo que quiera más declara la suya.
- **Primeros mundos:**
  - `plates` y `cells`: proporción de puntos exactos del check, con `exact/points` de su `operatorView`.
  - `threesum-subquadratic`: exponente de crecimiento frente a la referencia (más bajo es mejor) y, como métrica aparte,
    la corrección.
  - Los demás, con el valor por defecto hasta que declaren las suyas.

### 3.2 Orientación: mejorar es subir

- El eje vertical se orienta según `direction`: una métrica que mejora al bajar se dibuja con el eje invertido, para que
  el progreso sea siempre una subida, y **con sus valores reales en las etiquetas**, nunca transformados en otra cosa.
- `range` fija los límites naturales (0–1 en una proporción) y `scale: 'log'` sirve para métricas que mejoran por
  órdenes de magnitud.
- La dinámica de cada métrica la declara su mundo; la vista sólo la aplica.

### 3.3 Qué cuenta como muestra

- **Sólo lo que el protocolo mide:** checks, validaciones y checks de artefacto, que se hacen en realizaciones reservadas
  o en lugares de la familia. Nunca lo que el investigador mide en su exploración, que es su evidencia, no la del mundo.
- **Con su procedencia:** cada muestra lleva su ronda, lugar, tipo (check, validación, confirmación ciega) y el evento del
  que sale, y desde el inspector se abre el evento original.
- **Una ronda sin check** (cerrada sin modelo, sin propuesta) no da muestra, y la senda no la inventa (C9).

### 3.4 Nunca mezclar montañas

- **Varias métricas de un mundo:** una montaña por métrica, en paneles apilados con el mismo eje de tiempo. Nunca una
  puntuación combinada.
- **Mundos o condiciones distintos:** nunca en el mismo eje. Los runs de un lote se agrupan por su clave de
  comparabilidad (K2: condición, mundo, código, generador, criterios y, en un mundo vivo, condición del mundo, `adapted` y
  etiquetas de intervención). Cada grupo es un panel.
- **Dentro de un grupo:** cada realización es un escalador y no una réplica de los demás (K5). Comparar grupos es cosa
  de los resultados del lote, no de esta vista.

## 4. Quién es un escalador

| Espacio | Escaladores |
| --- | --- |
| Un run | Su junior y, colgando de él, sus ramas delegadas: cada rama arranca en el instante en que se pidió |
| Un equipo (investigación paralela) | Cada miembro |
| Una sesión compartida (mundo vivo) | Cada investigador miembro; las ramas compartidas como escaladores que se unen a mitad. Los actores que no son investigadores no escalan: sus actos aparecen como acontecimientos |
| Un lote | Cada run de cada condición, en el panel de su grupo |
| Una búsqueda evolutiva | Opcional: sus candidatos exportados como puntos de la rama, con su medida de exploración marcada como tal, y su adopción como cuerda hacia quien la adoptó |

El senior no escala, porque no es un investigador del mundo: aparece como un halo sobre su junior cuando le escribe y
como despertar cuando lo reactiva una lectura.

## 5. Cuerdas: lo que de verdad une a los escaladores

Cada cuerda tiene el significado de su relación (C5) y se dibuja del emisor al receptor en el instante de entrega, no en
el de envío:

| Cuerda | Evidencia |
| --- | --- |
| Mensaje entre miembros | `message_sent` y su recibo `r.<actor>.<id>` |
| Material compartido | `material_shared` y el episodio `from-<autor>--<nombre>` en el receptor |
| Publicación en el tablón del equipo | `peer_publish` y su lectura `peer_read` |
| Directiva del senior | `operator_message` con `directive` y el informe `directive_report` |
| Rama | `delegation_requested` (apertura) y `research_result` (entrega) |
| Adopción de un candidato evolutivo | `adoptedOf` |
| Anuncio del operador | `announcement` del mundo vivo |

Una cuerda sólo dice que algo llegó, no que influyera. Que después la senda suba se ve en el gráfico, pero la vista no lo
afirma.

## 6. Acontecimientos

Se dibujan como bandas verticales en la línea de tiempo, separados por su procedencia:
- **Del mundo vivo:** lo ocurrido sin que nadie lo pidiera, sólo en el perfil del operador; los disparos del operador con
  su modo y su etiqueta; los timeouts de ventana.
- **Del operador:** sus mensajes, que son ayuda; los cambios de foco o de fuentes; los cambios de programas durante el run
  (`adapted`).
- **Del arnés:** paradas, reanudaciones, rondas añadidas.

## 7. Recursos

- **Una barra por escalador:** tokens gastados frente a su presupuesto, sacados de su `status.json` en vivo y de su
  finding al terminar.
- **Una barra del fondo de ramas,** a partir de su libro.
- **Llamadas al Judge y dinero,** cuando se conocen. Lo desconocido aparece como desconocido, nunca como cero (C9).

Es el equivalente de la barra de memoria de local-autoresearch. Aquí el recurso escaso es el presupuesto de cada
investigador, no la RAM.

## 8. Modos

- **En vivo.** Se actualiza leyendo los diarios por cursor y los `status.json`. El escalador está donde está su última
  muestra, y su estado, según lo que hace ahora.
- **Reproducción.** Barra de tiempo, velocidad (de 1× a la investigación entera en 20 segundos), pausa y paso a paso.
  Reutiliza el corte del Observatorio: un instante de la reproducción es un corte, y desde él se consulta el pasado como
  pasado (C4).
- **Exportación.** Un HTML autocontenido con los datos incrustados que reproduce la animación sin servidor, y una imagen
  fija SVG del corte actual. Ninguna dependencia nueva que el usuario tenga que instalar (sin ffmpeg).

En los tres modos la vista sólo lee registros: nunca ejecuta código de un candidato ni vuelve a llamar a un modelo.

## 9. Perfiles

- **Operador:** todo, incluido lo ocurrido no percibido del mundo vivo y lo que guarda `hidden_from_the_learner`.
- **Registro de investigadores:** lo que el equipo percibió. Las muestras de la métrica sí aparecen, porque son veredictos
  que los investigadores reciben; lo restringido, no.

El servidor aplica el perfil, no la página (C6).

## 10. Datos

Un endpoint nuevo del Observatorio: `GET /api/research/climb?entities=...&profile=...&since=<cursor>`. Devuelve:

```ts
{
  groups: {                                 // uno por clave de comparabilidad
    key: Record<string, unknown>;
    metrics: Metric[];                      // la declaración del mundo (§3.1)
    climbers: {
      id: string; kind: 'run' | 'member' | 'branch' | 'candidate';
      parent?: string;                      // una rama cuelga de su solicitante
      joined_at: number;                    // segundos desde el inicio del espacio
      samples: { metric: string; t: number; tokens: number | null; round: number; value: number; kind: 'check' | 'validation' | 'blind' | 'artifact'; ref: string; accepted?: boolean }[];
      states: { t: number; state: string; ref: string }[];
      budget: { tokens_used: number | null; tokens_limit: number | null };
    }[];
    ropes: { kind: string; from: string; to: string; t: number; ref: string }[];
    events: { kind: string; t: number; to?: number; label: string; ref: string; profile: 'operator' | 'researcher' }[];
  }[];
  cursor: string;
}
```

- **Tiempo:** segundos de reloj desde el inicio del espacio. El eje alternativo en tokens acumulados se calcula de las
  mismas muestras.
- **Derivación:** sólo de los diarios, el diario del mundo, los registros de los agentes, los libros de fondos y los
  `status.json`; las referencias abren el evento original en el inspector.
- **Incremental:** por cursor, con el mismo snapshot que ya usa el Observatorio.

## 11. Accesibilidad y presentación

- Los colores siguen los tokens de tema del Observatorio, en claro y en oscuro. Cada escalador tiene un color estable
  ligado a su id, además de forma y etiqueta: el color nunca es la única pista.
- Con `prefers-reduced-motion`, la reproducción avanza por pasos, sin transiciones.
- Una tabla accesible con los mismos datos (escalador, muestra, tiempo, valor, referencia) acompaña al gráfico.
- En pantallas estrechas, los paneles se apilan y la leyenda pasa debajo.

## 12. Aceptación

1. La vista de un run, de un equipo, de una sesión compartida y de un lote se construye sólo desde sus registros, sin
   red y sin ejecutar código.
2. Una métrica que mejora al bajar se dibuja subiendo, con sus valores reales en las etiquetas.
3. Dos métricas de un mundo, o dos condiciones de un lote, nunca comparten eje ni se combinan.
4. Una ronda sin check no produce muestra.
5. Cada muestra, cuerda y acontecimiento abre su evento original.
6. Las cuerdas se dibujan en el instante de entrega, y sólo donde hay evidencia de entrega.
7. El perfil de investigadores no recibe nada restringido: lo comprueba el servidor y no la página.
8. La reproducción de una investigación terminada da, en cada instante, el mismo estado que tenía en vivo.
9. El HTML exportado reproduce la animación sin servidor y sin recursos externos.
10. Lo desconocido (coste, actividad, presupuesto) aparece como desconocido.

## 13. Entregas

| Etapa | Entrega |
| --- | --- |
| **VE1 · Contrato de la métrica** | `Lab.progress`, el valor por defecto, `plates`, `cells` y `threesum-subquadratic`, con pruebas de orientación |
| **VE2 · Datos** | El endpoint `climb` sobre runs, ramas, equipos, sesiones y lotes, con perfiles y cursor |
| **VE3 · Vista fija** | Pestaña «Escalada» en el Observatorio: sendas, cresta, cumbres, mesetas, cabecera y tabla accesible |
| **VE4 · En vivo y reproducción** | Escaladores animados, estados, barra de tiempo integrada con el corte |
| **VE5 · Cuerdas y acontecimientos** | Mensajes, material, tablón, directivas, ramas, adopciones; bandas del mundo vivo y del operador |
| **VE6 · Exportación** | HTML autocontenido y SVG del corte |

VE1 a VE3 son el primer producto útil. La primera prueba visual sería la sesión de `plates` del piloto y el lote de
3SUM atascado.

### 13.1 Hecho: VE1 a VE3 (27/10/2026)

**VE1, contrato de la métrica** (`lib/src/learn/progress.ts`):
- `Lab.progress` con la firma del §3.1. `axisOf` y `elevation` orientan el eje en el servidor: `bottom` va al pie y `top`
  a la cima.
- **Por defecto,** `places_holding`.
- **`plates` y `cells`:** `exact_share`.
- **`artifacts`:** cuatro métricas.
  - `places_holding`;
  - `correct`;
  - `growth_exponent`, la pendiente del peor lugar, con el eje invertido;
  - `cost_ratio`, el peor lugar, en escala logarítmica.

  Cada valor es el del peor lugar, porque un veredicto sólo se sostiene donde se sostiene en todos. Una métrica que su
  tarea no da no tiene muestras ni panel.

**VE2, datos** (`lib/src/console/climb.ts`):
- **Endpoint:** `GET /api/research/climb?entities=…&profile=…` o `?snapshot=…`, y `&since=<cursor>` para responder
  `unchanged`. `GET /api/research/climb-event` abre una muestra.
- **Muestras:** se leen de los eventos tal como los recibió el perfil, porque se toman de la misma captura que el
  Observatorio. Así el perfil de investigadores no da muestras de lo que el protocolo guardó para el operador.
- **Escaladores:**
  - las ramas se añaden solas y cuelgan de quien las pidió, desde el instante del `delegation_requested`;
  - el `.cut` de una rama no es un escalador.
- **Grupos:** por condición del lote, mundo, código, generador y, en un mundo vivo, su identidad.
- **Mesetas:** tres veredictos seguidos sin superar su mejor marca.
- **Cuerdas y acontecimientos:** se declaran como no leídos (`unread`). No se dibujan como si faltaran.
- **Un corte:** muestra sólo lo que contiene. No añade ramas ni conoce el gasto de entonces.

**VE3, vista fija** (pestaña «Escalada» del Observatorio):
- un panel por grupo y métrica, con sendas, cresta, cumbres ★ y mesetas sombreadas;
- la rama, marcada con una línea discontinua donde se unió;
- cabecera con la cumbre de cada métrica, el reloj y una barra de tokens por escalador, donde lo desconocido aparece
  como desconocido;
- tabla accesible y clic en cada muestra para abrir su evento.

La vista dibuja enseguida la última lectura y lee la siguiente en segundo plano: el catálogo del Observatorio tarda
unos 3 s en un espacio grande. Probada en el navegador con el lote de 3SUM atascado; las pruebas están en
`lib/test/climb.test.ts`.

### 13.2 Hecho: VE4 y VE5 (27/10/2026)

**VE4, en vivo y reproducción:**
- **`climbAt(view, t)`** (`lib/src/console/climb.ts`) da la escalada en un instante. Recoge lo ocurrido hasta `t`
  (veredictos, estados, cuerdas y acontecimientos) y recalcula mesetas, cresta y cumbre tal como estaban. Antes del
  final el gasto queda desconocido, y los ejes no se mueven.
  - El servidor calcula con ella la cresta y las mesetas de la escalada completa.
  - La página ejecuta esa misma función, inyectada en su código, para reproducir. Así una reproducción enseña lo
    mismo que un corte en ese instante.
  - `positionsAt(view, t)` da las posiciones de ese corte.
  - Una prueba compara, en varios instantes, la reproducción con el corte que el Observatorio fija ahí (aceptación 8).
- **Estado de cada escalador:** `stateOf` lo deduce del registro. Una investigación que sólo mira es «observa» y una
  que actúa sobre el mundo o el artefacto es «actúa». Los demás estados son espera, delega, propone, comprueba,
  cierra ronda y parado. Se dibuja como un glifo en el icono.
- **Barra de reproducción:** reproducir y pausa, paso a paso entre momentos con algo registrado, velocidad de 1× a «toda
  en 20 s», «En vivo» y «Fijar corte aquí». Esta última convierte el instante en un corte del Observatorio con todos
  los escaladores, ramas incluidas.
- **Movimiento reducido:** con `prefers-reduced-motion`, la reproducción avanza de momento en momento.
- **Sondeo:** mientras se reproduce, la página deja de pedir datos nuevos para no saltar.

**VE5, cuerdas y acontecimientos:**
- **Cuerdas,** dibujadas en el instante de entrega y sólo donde el registro la muestra:
  - un mensaje o material entre miembros: `message_sent` o `material_shared` en el emisor, y `messages_delivered` con
    el mismo id en el receptor;
  - el tablón: `peer_publish` y luego un `peer_read` que lo muestra;
  - la directiva del senior y el mensaje de un agente;
  - la apertura de una rama (`delegation_requested`) y su resultado (`research_result`);
  - la adopción de un candidato evolutivo (`adoptedOf`, en el paso donde hizo suya esa versión);
  - el anuncio del operador en un mundo vivo (`world_help`).

  Un mensaje rechazado, o uno sin envío de un miembro, no es cuerda. Quien no escala (senior, operador, rama o búsqueda
  evolutiva sin registro de investigador) entra por arriba con su marca.
- **Acontecimientos,** en tres carriles por procedencia:
  - **del operador:** órdenes, foco, fuentes y sus mensajes;
  - **del arnés:** paradas, rondas añadidas y continuación de un run anterior;
  - **del mundo:** cierre, divergencia y ventanas en las que alguien no decidió a tiempo.

  Y sólo en el perfil del operador, el registro del propio mundo vivo: lo ocurrido sin que nadie lo pidiera, los
  disparos y programas del operador, y las entradas y salidas de miembros. Se sitúan en el reloj por la primera vez
  que un miembro registró esa ventana.
- **Dibujo:** cada acontecimiento es además una línea tenue en cada panel. Las cuerdas y los acontecimientos tienen su
  tabla accesible y abren su evento; uno del registro del mundo se abre con sus datos.

Las pruebas están en `lib/test/climb.test.ts`: 11 en total. Una reproducción y un corte en el mismo instante coinciden
también sobre el lote real de 3SUM.

### 13.3 Hecho: VE6 y el perfil de investigadores (28/10/2026)

**VE6, exportación:**
- **«Exportar escalada»** (`GET /api/research/climb-export`, con la misma consulta que `climb`) da un único HTML.
  Lleva dentro los datos de la escalada, los eventos que cita (tal como los recibió el perfil, y nada más), los estilos
  del Observatorio y el mismo código de dibujo. Reproduce la escalada y abre cada muestra, cuerda o acontecimiento sin
  servidor ni recursos externos (aceptación 9).
- **El código de dibujo** vive en `lib/src/console/climb-page.ts`. Lo comparten el Observatorio y la exportación;
  `window.CLIMB_STATIC` dice que no hay servidor detrás.
- **«SVG del instante»** descarga los paneles del instante que se ve como un SVG propio, con los colores del tema y el
  estilo de las etiquetas escritos dentro, para que se lea igual fuera de la página.

**Perfil de investigadores:** el filtro del Observatorio (`researcherEvent`) admite ya lo que los investigadores hicieron y
recibieron en un equipo o un mundo vivo:
- sus mensajes y material enviados, y lo que se les entregó;
- el anuncio del operador;
- sus ventanas y lo que salió de sus propias acciones;
- el tablón, lo que publicaron y lo que leyeron;
- sus ramas;
- el cierre del mundo;
- el check de su artefacto tal como se lo comunicaron (`told`): si su versión se sostiene, es correcta y es mejor.

Siguen fuera lo ocurrido en el mundo sin percibirse, los plazos agotados de los demás y el detalle que el protocolo
guardó para el operador, como la pendiente del crecimiento. Con esto, en ese perfil aparecen las cuerdas entre miembros
y la montaña de la corrección del artefacto.

**Arreglado al probarlo en el navegador:**
- Abrir una muestra fallaba, porque un parámetro tapaba la función `data()` de la página.
- Tras fijar un corte, la vista se quedaba en «Leyendo…» si una lectura en vivo volvía sin cambios. Ahora, al terminar
  cada lectura, se pide la que haga falta.

**Pendiente:**
- El despertar del senior por una lectura, que está en el diario de su agente.
- La señal de estancamiento del mundo vivo en las mesetas.
- Muestras en tokens: `tokens` va siempre a `null` porque los eventos no llevan el gasto acumulado.
- Los candidatos evolutivos como puntos de la rama, que el spec deja como opcionales.

## 14. Límites

- No es una clasificación de investigadores ni produce una nota: describe una escalada. El método se lee al lado.
- No afirma causalidad: una cuerda seguida de una subida es secuencia, no prueba.
- No sustituye a los resultados del lote (K1–K5) ni a la Trayectoria por rondas: es otra lectura del mismo registro.
- La exploración del investigador no aparece como muestra de la montaña; sus experimentos se ven en su estado y en el
  inspector.
