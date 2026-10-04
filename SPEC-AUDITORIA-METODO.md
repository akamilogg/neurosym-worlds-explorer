# SPEC · Auditoría del método: una métrica más, sobre cómo investiga

Estado (04/10/2026): **MA1 y MA3 implementados** (`lib/src/audit/`, `lab audit <run> [--flat]`, §12). Pendientes: MA2
(extracción estructurada y verificador de hechos O6), MA4 (muestra etiquetada) y MA5 (auditar los runs existentes).

## 1. Motivación

Un run se mide hoy por su resultado: el modelo se sostiene en el check y se **valida en otros mundos donde rige la misma
regla** (variantes y familia del mundo). Esa métrica **no cambia y sigue siendo la que decide si un mundo se ha resuelto**,
es decir, si el investigador ha encontrado sus reglas internas. No exige conocer la verdad oculta: basta con que existan
mundos que comparten la regla y donde el modelo se pueda validar. Cuando el mundo lo ha escrito alguien y su verdad está
disponible, la recuperación de reglas (RR) es una lectura más del operador, no un requisito. Esta spec no sustituye ni
corrige nada de eso.

Lo que añade es **otra métrica, sobre otra pregunta**: si un modelo suficientemente capaz, con estas herramientas, **las
encadena de forma correcta y coherente con un método científico**:

hipótesis → experimento que la discrimina → resultado leído bien → creencia actualizada en proporción a la evidencia.

El resultado dice dónde llegó; esta métrica dice cómo llegó (o por qué no llegó). Las dos se leen juntas:

- Un run puede acertar con un método débil. Por ejemplo, el 8/8 de la ronda 8 del run grid-s22-2026-10-03T06-27-49-007Z
  no generalizaba, y el investigador sólo lo descubrió después.
- Un run puede no resolver el mundo con un método sólido. La continuación de ese mismo run hizo controles pareados,
  refutó una hipótesis del senior y registró como "no probado" un experimento que no se ejecutó, sin pasar de RR 0.5.

La auditoría mide el método eslabón a eslabón, a partir del journal, y se informa **junto a** las medidas de resultado.

## 2. Principios

- **M1. La auditoría es posterior y no ayuda.**
  - Se hace sobre un journal terminado, nunca durante el run.
  - Nada de lo que produce llega a ningún investigador: ni como mensaje, ni como fuente, ni como memoria. Si llegara, sería
    retroalimentación ajena, que el diseño prohíbe (aprendizaje sólo de fuentes propias).
  - La lee el operador (vista del operador, Q2 de SPEC-ORQUESTADOR).
- **M2. El método se juzga sin la verdad oculta.**
  - Si un experimento discrimina, si un resultado está bien leído o si una actualización es proporcionada se decide con lo
    que el investigador tenía delante, no con las reglas reales.
  - El acierto se toma aparte, de la métrica de resultado (lo que se validó en mundos con la misma regla y, si hay verdad
    disponible, el RR), para cruzar dos ejes independientes: método (bueno o malo) por acierto (correcto o incorrecto).
    "Coherente pero equivocado" es un resultado legítimo de un buen método.
  - Así la auditoría funciona igual en un mundo sin verdad conocida; sólo la tabla método × acierto depende de que haya
    habido validación.
- **M3. El código observa y Jev juzga** (como en el resto del proyecto).
  - El código extrae los eslabones y comprueba lo que es comprobable sin opinión. Por ejemplo, si un `act` fue rechazado,
    o si un paso citado existe y fue visto.
  - El juicio ("¿este experimento discrimina entre las hipótesis que había?") lo hace Jev, con preguntas cerradas.
- **M4. Igual para todos.** La auditoría es la misma para los dos investigadores, para cualquier mundo y para el senior
  (sus mensajes son hipótesis con experimento propuesto). Se apoya sólo en eventos comunes: `investigation`, `proposal`,
  `reflection`, `operator_message`, `check`, `consolidated`.
- **M5. No cambia nada del run.**
  - No hay campos nuevos en las respuestas del investigador ni cambios de prompt: el puro sigue congelado.
  - La auditoría trabaja con lo que el investigador ya escribe: rationale, beliefs con `stance` y `why`, notas, y citas
    del tipo "round 3, investigation step 2" o `g20@6`.
- **M6. El instrumento también se valida.** Antes de creer sus números se comprueba contra casos conocidos (§7) y contra
  una muestra etiquetada a mano por el operador.

## 3. La unidad: el eslabón

Un **eslabón** es un experimento con lo que lo rodea:

| campo | de dónde sale |
|---|---|
| `before` | las hipótesis vivas antes del paso: beliefs de la última propuesta, notas del investigador, mensaje del senior pendiente |
| `step` | las peticiones del paso de investigación (`act`, `replay`, `try`, `table`, `inspect`, `view`) |
| `result` | lo que el mundo respondió, resumido por código (aceptado o rechazado, puntuación, partida nueva, filas de la tabla) |
| `after` | la siguiente propuesta o reflexión: los beliefs nuevos, revisados o abandonados, sus `why`, y las citas de este paso |

Un `view` o un `table` también es un eslabón, pero de observación: se juzga si lo observado se cita bien después, no si
discrimina hipótesis.

Tamaño medido en 12 runs reales de la cuadrícula (10 rondas):

- 25–32 pasos de investigación por run, con 1–3 peticiones cada uno;
- unas 10 propuestas y 40–90 entradas de beliefs;
- unos 40k caracteres de razonamiento y 60–100k de resultados (sobre todo dibujos del tablero).

La continuación de 16 rondas llega a 47 pasos y 128 beliefs.

## 4. Lo que observa el código (sin LLM, coste cero)

- **O1. Experimentos que no lo fueron.** Un `act` rechazado o un `replay` sobre un punto inexistente, y si después se cita
  como evidencia a favor o en contra. Caso de referencia: el bloqueo de g112@12.
- **O2. Citas.** Para cada cita del razonamiento (`gNN@k`, "round r, step s"), si existe y si el investigador había visto
  ese tramo antes de citarlo.
- **O3. Resultados huérfanos.** Pasos cuyo resultado nunca se cita ni cambia ningún belief.
- **O4. Controles.** Pares de `act` o de `replay` desde el mismo punto con una sola diferencia, y si la propuesta siguiente
  los usa. Caso de referencia: g20@6, con (1,1) frente a (0,1).
- **O5. Movimiento de las creencias.** Por cada belief: cuántas veces se mantiene, revisa o abandona, y si se revisa en el
  paso siguiente a un resultado que lo contradice.
- **O6. Hechos comprobables (por mundo, opcional).** Un mundo puede dar un verificador de afirmaciones normalizadas, por
  ejemplo en la cuadrícula: {pieza, de, a, partida, paso}, que se contrasta con los fotogramas del journal. La
  normalización la hace el extractor (§5). Caso de referencia: el "salto" de g76@6–7 que afirmó el senior era un paso
  diagonal.

## 5. Lo que juzga Jev

Primero, una **extracción** por propuesta. Un LLM convierte el texto libre en afirmaciones estructuradas:
{afirmación, tipo (hecho | hipótesis | patrón de muestra), citas}. No juzga nada, sólo estructura. Debe ser de una
familia distinta a la del investigador auditado, para que nadie se lea a sí mismo con indulgencia.

Después, **una llamada a Jev por eslabón**, con preguntas de elección cerrada:

- **J1. Propósito:** el experimento pone a prueba una hipótesis viva (sí, en parte, no, no había hipótesis enunciada).
- **J2. Discriminación:** si la hipótesis fuera falsa, ¿el resultado habría salido distinto? (sí, no, indeterminado).
- **J3. Lectura:** cómo se lee el resultado después (correcta, sobreinterpreta, infrainterpreta, se ignora).
- **J4. Alcance:** la afirmación resultante declara su alcance (general, de la muestra, de este punto) de acuerdo con la
  evidencia (acorde, demasiado amplio, demasiado estrecho).

Y **una llamada por ronda**:

- **J5. Respuesta a la refutación:** ante evidencia contraria a un belief vivo, revisa, mantiene con razón explícita o
  mantiene sin razón.
- **J6. Uso del control:** cuando afirma una causa, ¿hay comparación o línea base?

El estado que ve Jev contiene sólo el eslabón (texto y medidas del código), con el contrato neutral, sin nada del mundo
que el investigador no viera.

## 6. Medidas del run

Se derivan de las etiquetas, sin opinión añadida:

- **cadenas completas:** eslabones con J1 = sí, J2 = sí, J3 = correcta y J4 = acorde;
- **tasa de propósito** (J1), **tasa de discriminación** (J2), **sobreinterpretación** (J3) y **alcance acorde** (J4);
- **exactitud de citas** (O2) y **exactitud de hechos** (O6);
- **experimentos fantasma** (O1);
- **respuesta a la refutación** (J5) y **uso de controles** (O4 y J6);
- **la tabla método × acierto** (M2): cuántas afirmaciones son coherentes y correctas, coherentes pero falsas,
  incoherentes pero correctas, o incoherentes y falsas. "Correcta" quiere decir que la confirmó la validación en mundos
  con la misma regla (o el RR, si hay verdad); sin validación, la tabla queda vacía y el resto de medidas sigue valiendo.

Todo se escribe en un `method_audit@1` junto al journal (`<run>.method.json`). El finding del operador lo enlaza; el del
investigador, no.
El finding del operador muestra estas medidas al lado de las de resultado (check, validación y, si hay verdad, RR), sin combinarlas en
una sola nota.

## 7. Validar el instrumento

**Casos de referencia** sacados de runs reales, que el instrumento debe clasificar bien:

| caso | esperado |
|---|---|
| g20@6: par de `act` (1,1) frente a (0,1), +1 frente a seguir | control (O4); J2 = sí; J3 = correcta |
| `act` rechazado en g112@12 | experimento fantasma (O1), registrado correctamente como "no probado" (J3 = correcta) |
| "salto" del senior en g76@6–7 | hecho falso (O6) |
| "`&` se mueve ortogonal o diagonal" | J4 = demasiado amplio |
| replays del modelo de la ronda 8 como línea base (rondas 12–14) | control (O4); J5 = revisa ("no es garantía general") |

Además se usan journals sintéticos con defectos sembrados (citas a pasos que no existen, conclusiones contrarias al
resultado) y **una muestra de unos 30 eslabones etiquetada por el operador**, para medir el acuerdo de Jev con una
persona. Si el acuerdo es bajo en una pregunta, se reformula o se pasa al código.

## 8. Coste

Medido sobre los 12 runs de la cuadrícula del 02–03/10. Un run típico tiene ~28 eslabones y ~10 propuestas.

### Lo que gasta la auditoría de un run

| fase | quién | volumen | coste |
|---|---|---|---|
| O1–O6 | código | — | 0 |
| extracción | LLM | 10 llamadas · ~6k tokens de entrada · ~2k de salida | ver tabla siguiente |
| J1–J4 | Jev | ~28 llamadas (una por eslabón, varias preguntas por llamada) | ver la nota sobre Jev |
| J5–J6 | Jev | ~10 llamadas | ver la nota sobre Jev |

**Extracción con LLM** (~60k tokens de entrada y ~20k de salida por run; el prompt del sistema se cachea, el resto apenas):

| modelo de extracción | coste por run |
|---|---|
| Luna ($0.10 entrada / $0.50 salida por 1M) | **≈ $0.02** |
| gpt-6.1-sol ($2 / $10 por 1M) | ≈ $0.32 |
| Qwen local | 0 $ (tiempo de GPU) |

**Si J1–J6 los juzgara un LLM en vez de Jev** (alternativa, no recomendada por M3): ~38 llamadas con ~5k tokens de entrada
y ~400 de salida, unos 190k de entrada y 15k de salida:

| juez LLM | coste por run |
|---|---|
| Luna | ≈ $0.03 |
| gpt-6.1-sol | ≈ $0.53 |

**Jev:** son ~38 llamadas por run. Lo que ya gasta un run de la cuadrícula en Jev varía mucho: desde ninguna llamada
(runs con `--flat` o sin Jev) hasta decenas de miles. En los runs del 02/10 fueron 600–25.000 llamadas en los checks, y la
continuación hizo 18.809 entre replay y vivo. En un run con Jev, la auditoría añade **menos del 1 %**; en uno sin Jev,
es su único uso. No tenemos el precio por llamada de Jev en el repositorio, así que el impacto se expresa en llamadas.

### Comparado con lo que cuesta el run

| run | coste del run | auditoría (extracción Luna + Jev) | proporción |
|---|---|---|---|
| Luna + senior (10 rondas) | $0.33 | ≈ $0.02 + 38 llamadas a Jev | ~6 % |
| Sol solo con memoria | $1.29 | ≈ $0.02 + 38 llamadas a Jev | ~2 % |
| continuación de 16 rondas (Luna + senior) | ~$0.58 | ≈ $0.04 + ~60 llamadas a Jev | ~7 % |
| Qwen local | 0 $ | ≈ $0.02 + 38 llamadas a Jev | — |

La parte cara sería usar Sol como extractor o como juez (≈ $0.85 por run, más de lo que cuesta un run de Luna + senior).
No hace falta: la extracción es una tarea de estructurar, no de razonar.

### Lo que cuesta validar el instrumento (una vez)

- Casos de referencia y journals sintéticos: con LLM sustituto en las pruebas, 0 $.
- Muestra etiquetada: unos 30 eslabones, sobre una hora del operador, más ~30 llamadas a Jev.
- Recalibrar tras reformular una pregunta: otra pasada de ~30 llamadas.

### Para comparar modelos

Para la pregunta de fondo (¿un modelo más capaz encadena mejor las herramientas?) hace falta auditar runs ya hechos: Qwen,
Luna, Sol, con y sin senior. **Auditar los ~20 journals comparables que ya existen (hay 64 con investigación) cuesta unos $0.40 con extracción en Luna, más ~800
llamadas a Jev**, sin lanzar ningún run nuevo. Las réplicas nuevas, si hacen falta para separar el ruido, cuestan lo que
cuesta el run; la auditoría sobre ellas es marginal.

## 9. Evidencia que la sostendría

- El instrumento clasifica bien los casos de §7 y concuerda con el operador en la muestra etiquetada.
- Las medidas separan a los modelos de forma estable entre réplicas. Esperado: Qwen < Luna ≤ Sol en cadenas completas y
  exactitud de citas.
- **La señal que buscamos:** que un modelo más capaz tenga más cadenas completas, más respuesta a la refutación y menos
  sobreinterpretación con las mismas herramientas. Eso indicaría que el método está al alcance de las herramientas y que
  lo que falta es capacidad, no instrumentos.
- **La señal contraria:** que ningún modelo pase de cierto techo en una pregunta concreta, por ejemplo J2 (discriminación).
  Eso apuntaría a una herramienta que falta o que no se deja encadenar, y sería un hallazgo sobre el diseño, no sobre el
  modelo.
- Que el método y el acierto (M2) no estén perfectamente correlacionados: entonces la métrica del método aporta
  información que la validación no da. Si lo estuvieran, seguiría siendo útil para explicar *por qué* un run no resolvió el mundo,
  pero no como señal independiente.

## 10. Plan

- **MA1.** Extractor de eslabones y observaciones de código O1–O5, con los casos de §7 como pruebas. Sin LLM.
- **MA2.** Extracción estructurada (LLM) y verificador de hechos O6 para la cuadrícula.
- **MA3.** Preguntas J1–J6 a Jev; `method_audit@1`; comando `lab audit <run>`.
- **MA4.** Muestra etiquetada por el operador y medida de acuerdo.
- **MA5.** Auditoría de los journals existentes y comparación entre modelos (§9).

## 11. Preguntas abiertas

- ¿Un `view` sin hipótesis previa es mal método o exploración legítima? Propuesta: no se penaliza en J1, pero se cuenta
  aparte (proporción de exploración frente a prueba por ronda).
- El senior propone experimentos que ejecuta el junior: ¿de quién es el eslabón? Propuesta: el propósito (J1) es del
  senior y la lectura (J3) del junior; se informan por separado.
- ¿Conviene que el extractor vea los fotogramas citados para normalizar mejor las afirmaciones, a costa de más tokens?
  Con dibujos ASCII de ~150 tokens por fotograma, citar 5 por propuesta añade ~750 tokens: poco.

## 12. Lo implementado (04/10/2026)

**MA1 · Lo que observa el código** (`audit/links.ts`). Reconstruye los eslabones de un journal terminado. Cada uno lleva:

- lo que el investigador tenía antes: sus creencias no abandonadas y el mensaje del operador que aún no había contestado;
- lo que pidió;
- lo que respondió el mundo, compactado (sin dibujos largos y con las tablas recortadas);
- lo que escribió después: la siguiente propuesta o reflexión, y qué parte de ella cita el paso.

Sobre eso calcula O1–O5 con tres ajustes respecto a §4:

- **O1 son experimentos rechazados, no "fantasma".** Un `act` rechazado puede ser evidencia en sí (un movimiento que no es
  legal) o una prueba que no llegó a hacerse (el bloqueo de g112@12). Cuál de las dos cosas es lo decide el juicio (J3),
  no el código. El código informa del rechazo y de quién lo citó después.
- **O4 distingue tres comparaciones:**
  - `paired`: peticiones desde el mismo punto que difieren;
  - `replicated`: la misma petición repetida;
  - `against_recorded`: un replay contrastado con el episodio grabado del que parte. Aquí entran las líneas base del
    modelo de la ronda 8 en las rondas 12–14.
- **O2/O3 cuentan como cita más formas de referirse a un paso:** el punto `g20@6`; el paso ("round 3 investigation step
  2", `investigation:r8.2`); un episodio que el paso creó, nombrado solo (`g94`) o dentro de un rango (`g94–g96`); y los
  puntos que mostró un check (`check8-lab1-2@4+1`).

**MA3 · Lo que juzga Jev** (`audit/judge.ts`). Usa las preguntas cerradas J1–J4 por eslabón experimental y J5–J6 por
ronda, con el contrato neutral.

- Jev ve sólo los textos del eslabón: `held_before`, `operator_message`, `requests`, `result` y `written_after`.
- Para separar lo que propone el senior, J1 tiene la opción `operator`.
- Cada veredicto guarda la opción más probable, su probabilidad y la distribución entera.

**El fichero** `method_audit@1` (`<run>.method.json`, `audit/audit.ts`) contiene:

- las medidas (§6), con `complete_chains` y los repartos de cada pregunta;
- el resultado del run al lado, sin combinarlo: sus checks, si aceptó y la recuperación de reglas si la hay;
- lo observado y lo juzgado.

Además:

- El journal no se toca.
- El finding del operador enlaza la auditoría (`operator.method_audit`), también tras `lab grade`; el del investigador nunca
  la ve.
- `lab list` no confunde el fichero con un run.

**Uso:**

- `lab audit <run>` necesita `JEV_KEY`.
- `lab audit <run> --flat` sólo hace lo del código y no cuesta nada.

**Pruebas** (`audit.test.ts`): un journal sintético con los casos de referencia sembrados (el par de `act` desde el mismo
punto, el `act` rechazado y citado, una cita a un episodio inexistente, otra a un punto nunca visto, un paso huérfano, el
mensaje del senior, la réplica y el replay contra lo grabado) y un Jev sustituto. Comprueban que:

- Jev no ve nada oculto: ni la verdad, ni las medidas del operador, ni sus notas;
- las medidas no se combinan en una nota;
- el journal queda igual;
- el comando funciona en `--flat`.

**Primera lectura** (`--flat`, sobre una copia de la continuación grid-s22 de 16 rondas):

- 15 experimentos, 29 observaciones y 3 lecturas de registro;
- 388 citas, todas a algo visto;
- 2 experimentos rechazados, los dos citados después;
- 4 pasos huérfanos;
- 14 comparaciones, todas usadas: 3 pareadas, 1 replicada y 10 contra lo grabado;
- 19 creencias, 4 revisadas.

**Pendiente:**

- **MA2:** extracción estructurada y O6. Hace falta para el caso del "salto" del senior, que es un hecho falso, y para
  la tabla método × acierto por afirmación.
- **MA4:** la muestra etiquetada por el operador, para medir el acuerdo con Jev.
- **MA5:** auditar los runs existentes.

