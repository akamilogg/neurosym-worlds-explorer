# SPEC · El mundo de artefactos: construir y optimizar con método científico

Estado: en construcción (14/10/2026). Idea del autor. Hecho: §18.

## 1. De dónde sale

El arnés se construyó para entender entornos desconocidos. Tiene rasgos que interesan fuera de la ciencia:
- **Deja evidencia de cada acción:** qué hizo, por qué, cómo respondió el entorno y qué creencia sostenía.
- **Puede volver atrás con inteligencia:** si cae una creencia, no basta con volver a un commit anterior; hay que
  descartar lo que se apoyaba en ella.
- **Atiende por observaciones:** el investigador elige qué medir y reduce un entorno enorme a las pocas magnitudes que
  importan.
- **Protege contra engañarse:** casos nuevos en cada check, validación en otras variantes, confirmación a ciegas y
  predicciones prerregistradas.

El autor quiere usarlo para tareas de código y de optimización de automatizaciones: encontrar una forma más rápida de
completar un flujo, por ejemplo. Para un sistema evolutivo son buenas propiedades. **La dificultad:** el arnés optimiza una
respuesta, un modelo de un mundo fijo, mientras que en una tarea de código lo que se quiere es el propio artefacto.

## 2. La idea: el artefacto es el mundo, y el modelo es de su comportamiento

Se conservan las dos capas del arnés, cambiando dónde está cada cosa:
- **El mundo es el artefacto en ejecución,** y es **modificable:** cambiarlo es una intervención, como hoy `act` quita o
  escala conexiones del circuito de c302.
- **La respuesta tiene dos partes:**
  1. **El artefacto:** la versión del programa o del flujo que se entrega. Es el producto.
  2. **El modelo de su comportamiento:** qué determina su rendimiento y su corrección, y qué efecto tendrá cada cambio.
     Por ejemplo: "el 70 % del tiempo se va en la deduplicación; con un índice por clave baja al menos un 20 % en cargas con
     muchas claves repetidas, y no cambia en las demás". Es la comprensión que guía la búsqueda.
- **Se juzgan las dos.** El artefacto, por su corrección y su mejora en cargas nuevas. El modelo, por si sus predicciones
  sobre el efecto de los cambios se cumplen.

Así la búsqueda es evolutiva pero no ciega. Cada variante es una mutación guiada por una hipótesis, y la hipótesis se
corrige con lo que pasa.

## 3. Principios

- **Corrección antes que rendimiento.** Una variante más rápida y rota no existe: el oráculo de corrección decide
  primero.
- **Sin sobreajuste al benchmark.** Igual que en los mundos de leyes: casos nuevos en cada check, familias de carga
  distintas para validar y cargas que nadie ha visto para confirmar.
- **Medir con ruido.** Los tiempos varían: el veredicto repite ejecuciones y compara con margen, nunca con una sola
  medida.
- **Toda acción con su razón.** Cada cambio del artefacto va con la hipótesis que lo motiva y su predicción, registradas
  antes de medir.
- **Aislamiento.** El artefacto se ejecuta en un sandbox, sobre réplicas y nunca sobre sistemas reales. Sólo sale a la red
  si la tarea lo declara y hacia los destinos que declara.
- **Las reglas de siempre:** el entorno da veredictos y primitivas, no análisis hechos (sin investigación precocinada);
  el investigador mide el resto con sus instrumentos.

## 4. La tarea: qué declara un mundo de artefactos

Cada tarea es un laboratorio, con la interfaz común (`Lab`), y declara:
- **El artefacto base:** el código de partida (un repositorio o un directorio), su punto de entrada y cómo se construye.
- **El oráculo de corrección:** cómo se decide que una salida es correcta. Puede ser la igualdad con la salida de la
  versión de referencia, unos tests, unas propiedades (por ejemplo, "ordenada y con los mismos elementos") o una
  combinación.
- **El generador de cargas:** las entradas con que se ejecuta, por familias (tamaños, distribuciones, proporción de claves
  repetidas, casos límite), con semilla. Una familia es el equivalente a un lugar.
- **Las métricas:** qué se optimiza (tiempo de pared, CPU, memoria máxima, número de llamadas a una API, coste) y en qué
  dirección. Una principal, y el resto como restricciones (por ejemplo, "la memoria no puede crecer más de un 10 %").
- **El margen de mejora:** cuánto tiene que mejorar una variante para contar como mejor, con qué número de repeticiones y
  con qué criterio estadístico (§8).
- **El sandbox:** lenguaje y runtime, límites de CPU, memoria y tiempo, ficheros accesibles y red permitida.

## 5. El artefacto, versionado

- **Cada versión es un estado del mundo,** identificada por el hash de su contenido. El diario guarda el árbol de
  versiones: de qué versión sale cada una y con qué cambio.
- **Un cambio es un parche** sobre una versión existente. Puede ser un diff, la sustitución de un fichero o de una
  función. Se aplica en el sandbox, se construye, y si no compila o no construye se rechaza, diciendo por qué.
- **No hay una "versión actual" impuesta.** El investigador elige de qué versión parte cada cambio. Volver atrás es partir
  de una versión anterior, y nunca se pierde nada.

### 5.1 Lo que no es: no reimplementar git

El autor teme acabar reimplementando git (14/10/2026). El riesgo es real: un árbol de versiones por hash se parece mucho a
git, y cada necesidad nueva (fusionar ramas, mover archivos, versiones grandes) empuja hacia él. La frontera:

- **Lo que necesitamos y git no tiene:** el vínculo de cada versión con su razón. Qué hipótesis motivó el cambio, qué
  predijo, qué se midió, en qué creencias se apoya y qué se invalida si cae una (§9). Eso es el valor del mundo, y vive en
  el diario, no en el control de versiones.
- **Lo que git tiene y no necesitamos, y no se construye:**
  - **fusiones automáticas:** combinar dos ramas es un cambio más que escribe el investigador, declarando en qué creencias
    de cada rama se apoya (§12);
  - historia reescribible, ramas con nombre, etiquetas, remotos;
  - parches por líneas con contexto: un parche sustituye o quita archivos enteros, o una región que el propio
    investigador indica;
  - detección de renombrados, archivos binarios grandes, permisos.
- **El almacén se queda mínimo:** contenido por hash, padre y parche, y `diff`, `view` y `materialize`. Si algo de lo
  anterior hace falta de verdad, el criterio es **usar git, no imitarlo**. Git ya está en la máquina de quien trabaja con
  código, así que no sería una dependencia nueva como lo sería Docker. Por ejemplo:
  - artefactos que son repositorios grandes: el almacén guarda las versiones como objetos de git
    (`git hash-object`, `git worktree` para materializar), en lugar de copias completas;
  - entregar el artefacto aceptado: se exporta como una rama o un commit del repositorio del usuario, con el mensaje que
    resume su razón y sus predicciones cumplidas.
- **Señal de alarma:** si una tarea pide fusionar texto línea a línea o resolver conflictos, no se resuelve en el
  almacén. Es trabajo del investigador, como cualquier otro cambio, o es el momento de delegar en git.

## 6. Los actos

Lo que hoy es `act` se divide en primitivas del mundo:

| Acto | Qué hace | Coste |
|---|---|---|
| `change` | aplica un parche a una versión y crea otra nueva (construida, no ejecutada) | un acto |
| `run` | ejecuta una versión sobre cargas de las familias de sus laboratorios, con repeticiones; devuelve salidas, corrección por caso y métricas | uno por lote de ejecuciones, con tope de casos |
| `profile` | lo mismo con instrumentación del runtime: perfil de CPU, trazas, asignaciones de memoria | un acto (más caro) |
| `diff` / `view` | lee el código de una versión, o la diferencia entre dos | gratis |

Los resultados de `run` y `profile` son los **episodios** de este mundo. Se guardan enteros y los leen `view`, `measure`,
`table` y los instrumentos propios.

## 7. El percepto y las observaciones

**Lo que se sabe antes de ejecutar y lo que la ejecución revela van separados,** como en los mundos de leyes, donde el
percepto de un punto nunca contiene lo que hay que predecir en él (corregido tras una revisión externa, 14/10/2026: la
primera versión daba al modelo las métricas de la misma ejecución que debía predecir, y bastaba con copiarlas).

**El percepto de un punto** (una versión sobre una carga) es sólo lo disponible **antes** de ejecutarla:
- la carga: su familia, sus parámetros y la propia entrada, o un resumen que la tarea declare;
- la versión: su hash, su código y sus cambios respecto a la de partida.

**Lo que salió** (`came`, como en los demás mundos) es lo que la ejecución revela **después**, y nunca entra en el
percepto del mismo punto:
- las métricas medidas;
- la corrección del caso;
- el perfil, si lo hubo.

Sus observaciones extraen del percepto las magnitudes que, según su modelo, deciden el rendimiento: el tamaño de la
entrada, la proporción de repetidos, si la versión usa un índice. La salida del modelo predice la métrica de esa
ejecución. Lo que aprendió de perfiles y métricas de **otras** ejecuciones (sus episodios) lo lleva a su modelo por la vía
de siempre: sus creencias, sus documentos y el código que escribe, no leyéndolo en el punto que predice.

Así el modelo es comprobable como en un mundo de leyes: **predice el rendimiento de una versión en una carga.** Y es útil:
sirve para elegir qué cambio probar antes de gastar ejecuciones.

## 8. El veredicto

Dos veredictos, ambos del entorno y ambos sólo "se sostiene o no", sin métrica añadida para el investigador.

**El del artefacto,** con el protocolo de siempre:
- **Check:** la versión propuesta se ejecuta sobre cargas nuevas de las familias de sus laboratorios, con repeticiones.
  - Se sostiene si es **correcta en todos los casos** y mejora la métrica principal sobre la referencia por encima del
    margen, con el criterio estadístico de la tarea. Por ejemplo, intervalo de confianza de la mediana del cociente de
    tiempos por debajo de 1 − margen.
  - Las restricciones no pueden empeorar más de lo permitido.
- **Regresión emparejada:** los casos del check anterior se vuelven a ejecutar con la versión nueva, y no puede ir peor.
- **Validación:** en las familias de carga que no ha visto. Una familia donde no se sostiene pasa a ser laboratorio.
- **Confirmación a ciegas:** en cargas que nadie ha visto, generadas de familias reservadas.

**El del modelo,** con las pruebas propias:
- Antes de medir, el investigador registra qué predice su modelo de un cambio (por ejemplo, "la versión nueva baja al
  menos un 20 % en la familia de claves repetidas, y no más de un 5 % en las otras"), frente a un rival: otro modelo, o
  "el cambio no influye".
- El entorno ejecuta y responde si se cumplió. Una predicción que falla queda como contraejemplo abierto.
- `--own-tests N` exige N predicciones severas cumplidas antes de la confirmación a ciegas, como ya existe.

**La aceptación** necesita las dos cosas: un artefacto confirmado a ciegas, y un modelo cuyas predicciones prerregistradas
se cumplieron. Un artefacto que mejora sin que nadie sepa por qué se acepta como artefacto, pero el finding lo marca como
**no explicado**.

## 9. Volver atrás por creencias

El cuaderno ya guarda creencias con su evidencia. Aquí se añade un vínculo:
- **Cada cambio declara en qué creencias se apoya:** `"because": ["<belief id>", ...]`.
- **Cuando una creencia cae** (se descarta o la refuta una prueba), el entorno lista las versiones cuyos cambios se
  apoyaban en ella, y si siguen en la línea de la versión vigente. Es un hecho del registro, no un análisis: decidir qué
  revertir sigue siendo del investigador.
- **El senior lo revisa:** un cambio que sobrevive a la caída de su razón es un cambio sin justificar.

Así, volver atrás no es "ir al commit anterior": es quitar justo lo que dependía de lo que resultó falso y conservar lo
demás.

## 10. El sandbox

**Sin dependencias** (regla del autor, 14/10/2026): nada de Docker ni de otro software que el usuario tenga que
instalar o arrancar. El sandbox es una interfaz, y hoy tiene un backend de procesos locales:
- **Un proceso por ejecución,** con el runtime declarado (Node, Python, una shell), en un directorio de trabajo nuevo,
  con la versión del artefacto copiada junto a la carga.
- **Un entorno vacío:** sólo lo que encuentra el runtime, y ninguna clave ni variable del anfitrión.
- **Límites:** tiempo de pared (el proceso se mata al pasarlo) y tamaño de lo que escribe en su salida.
- **Ruido controlado:** misma máquina y ejecuciones alternadas (referencia y variante intercaladas), para que la deriva
  de la máquina no se confunda con mejora. La tarea declara cuántas repeticiones.

**Lo que este backend NO hace:** aislar. El proceso puede llegar a la red y a los archivos que el usuario puede, y no
limita memoria ni CPU. Por eso:
- **Sólo para artefactos de confianza:** los del propio operador, o código del investigador sobre tareas suyas. Cada
  ejecución dice que no estaba aislada, y el finding lo recoge.
- **Las automatizaciones que llaman a APIs** se ejecutan contra réplicas o simuladores declarados en la tarea. Lo
  garantiza la tarea (sus direcciones), no el sandbox.
- **Un backend que aísle** puede añadirse después sin cambiar nada de lo que ejecuta artefactos, siempre que no imponga
  dependencias. Queda como pregunta abierta (§16).

## 11. Repetir y reanudar

- **El artefacto** se reconstruye exactamente de su árbol de versiones: cada versión es su base más su parche, y se
  identifica por hash.
- **Las mediciones tienen ruido:** volver a ejecutarlas daría otros números. Por eso se graban como respuestas del entorno
  (canal `env`), igual que hoy las simulaciones de c302, y al repetir un run se sirven del registro.
- **Los instrumentos propios** se vuelven a ejecutar, porque son deterministas sobre los episodios grabados.

## 12. En paralelo: población de variantes

La investigación en paralelo (SPEC-INVESTIGACION-PARALELA) da el lado evolutivo:
- **Varios equipos** parten de la misma base y exploran hipótesis distintas: ramas.
- **El tablón** comparte hallazgos con su evidencia: "la deduplicación domina en cargas repetidas".
- **Las confirmaciones a ciegas son del equipo,** y no se gastan dos veces en la misma carga.
- **Combinar ramas:** un equipo puede partir de la versión de otro y declarar en qué creencias de ese otro se apoya. Así
  la combinación queda justificada y deshacerla es posible.

## 13. Qué se reutiliza y qué hay que construir

**Se reutiliza tal cual:**
- el investigador asistido y el senior;
- el cuaderno, los documentos propios y las preguntas abiertas;
- el protocolo de check, familia y ciegas;
- las pruebas propias y el estado de los experimentos;
- los instrumentos propios, para analizar perfiles y tiempos;
- la memoria selectiva y la experiencia entre runs;
- la repetición y la reanudación, los presupuestos con cierre, los lotes emparejados y los equipos;
- la auditoría del método y el registro de anomalías del instrumento.

**Hay que construir:**
1. **El sandbox de ejecución:** procesos locales sin dependencias, runtimes y límites (§10).
2. **El artefacto versionado:** árbol de versiones por hash, parches, construcción y `diff`/`view` de código.
3. **El objetivo "optimizar":** veredicto con oráculo de corrección, repeticiones, criterio estadístico y restricciones.
4. **Los actos** `change`, `run` y `profile`, y su percepto.
5. **El vínculo cambio → creencias** y la lista de versiones afectadas cuando cae una.
6. **La respuesta doble** en el finding: el artefacto aceptado, su modelo, y si está explicado.

## 14. El primer caso

Pequeño, local y sin red, para probar el mundo antes de llevarlo a automatizaciones reales:
- **Artefacto:** un script de procesamiento de datos, escrito a propósito con ineficiencias reales y variadas: lectura
  completa en memoria, deduplicación cuadrática, ordenaciones repetidas, expresiones regulares recompiladas.
- **Oráculo:** igualdad con la salida de la versión de referencia, tras normalizar el orden si la tarea lo permite.
- **Familias de carga:** tamaño (pequeño, mediano, grande), proporción de claves repetidas y anchura de registro. Una
  familia queda reservada para la confirmación a ciegas.
- **Métricas:** tiempo de pared (principal) y memoria máxima (restricción).
- **Lo que esperamos ver:**
  - que el modelo identifique qué ineficiencia domina en cada familia;
  - que prediga el efecto de cada cambio antes de medirlo;
  - que no acepte mejoras que sólo lo son en la familia donde se probaron.

Después, una automatización real con sus APIs simuladas.

## 14.1 Más allá del código: formas, diseños y CAD

El autor apunta (14/10/2026) que el mundo sirve igual para **refinar formas o hacer diseños CAD**. La estructura no
cambia: el artefacto es el diseño, y el modelo es el de su comportamiento.

| Pieza | Código | Diseño o CAD |
|---|---|---|
| Artefacto | el programa | el diseño paramétrico: un script CAD (OpenSCAD, CadQuery), una escena de Blender, una malla con sus parámetros |
| Cambio | un parche | cambiar parámetros o geometría: un radio, un espesor, un perfil, una topología |
| Oráculo de corrección | salidas iguales a la referencia | restricciones: dimensiones, holguras, sin interferencias, fabricable (paredes mínimas, voladizos, ensamblaje) |
| Cargas por familias | entradas de datos | casos de uso: cargas mecánicas, condiciones de flujo, temperaturas, tolerancias de fabricación |
| Métrica | tiempo, memoria | masa, rigidez, tensión máxima, arrastre, coste de material, tiempo de impresión |
| `run` / `profile` | ejecutar y perfilar | simular: elementos finitos, CFD, físicas de Blender, cálculo de propiedades de masa |
| Modelo del comportamiento | qué determina el rendimiento | qué determina la métrica: "la tensión se concentra en el chaflán; un radio mayor la baja a la mitad sin añadir más de un 5 % de masa" |

**Lo que aporta aquí el arnés:**
- **Predicciones antes de simular:** cada cambio de forma va con su efecto esperado, y se aprende de los que fallan. Las
  simulaciones son caras, y un modelo que acierta evita muchas.
- **Validación en otras familias de carga y a ciegas:** un diseño optimizado para un caso de carga suele fallar en otro;
  el protocolo obliga a comprobarlo antes de aceptarlo.
- **Volver atrás por creencias:** si cae la hipótesis que justificaba un refuerzo, se ven qué cambios dependían de ella.

**Lo que habría que añadir para este dominio:**
- un simulador por tarea, dentro del sandbox y sin dependencias que el usuario tenga que instalar aparte. Blender ya se usa
  en el mundo 3D; otros simuladores dependerían de la tarea;
- un percepto geométrico: medidas del diseño que sus observaciones puedan leer (dimensiones, volúmenes, secciones), antes de
  simular, como en §7;
- métricas con ruido numérico (mallados, convergencia), que el criterio estadístico del veredicto ya contempla.

Sería un segundo caso después del primero de código (§14).

## 14.2 Un gimnasio de RL: enseñar a un robot

El autor propone (14/10/2026) usar el mundo para optimizar un gimnasio de aprendizaje por refuerzo que enseñe a un robot,
partiendo sólo de los parámetros que definen el score.

| Pieza | Gimnasio de RL |
|---|---|
| Artefacto | la configuración de entrenamiento: función de recompensa, currículo, aleatorización del entorno, hiperparámetros, arquitectura de la política |
| Cambio | modificar la recompensa, un hiperparámetro, el currículo o la aleatorización |
| `run` | entrenar una política, con varias semillas, y evaluarla |
| Métrica | el score de la tarea, medido sobre la política ya entrenada |
| Familias de carga | condiciones del entorno: terrenos, masas, fricciones, perturbaciones, objetivos |
| Confirmación a ciegas | condiciones reservadas que el entrenamiento nunca vio |
| Modelo del comportamiento | qué hace aprender o no a la política, por ejemplo: "la penalización por velocidad articular impide que aprenda a saltar; bajarla a la mitad le deja superar el escalón sin aumentar las caídas" |

**La condición clave: recompensa y score separados.**
- **La recompensa es parte del artefacto:** el investigador la cambia, porque es su herramienta para enseñar.
- **El score es el veredicto del entorno:** los parámetros que definen qué es hacerlo bien los declara la tarea, son fijos
  y el investigador no los toca.
- Si la misma cosa se optimizara y se evaluara, aparecería el **reward hacking**: la política aprende a puntuar sin hacer
  la tarea. Las defensas son las del protocolo:
  - el **oráculo de corrección**, distinto del score: restricciones del comportamiento que se quiere, como no caerse, no
    pasar de ciertos esfuerzos o terminar en la postura pedida;
  - la **validación** en otras familias de condiciones;
  - la **confirmación a ciegas** en condiciones que el entrenamiento no vio. Una política que puntúa sin hacer la tarea
    casi nunca generaliza.

**Lo que lo hace caro y delicado:**
- **Cada `run` es un entrenamiento completo:** minutos u horas. Es donde más vale el modelo, porque predecir el efecto de
  un cambio antes de entrenar ahorra entrenamientos.
- **El ruido entre semillas es grande:** el veredicto necesita varias semillas por versión y un criterio estadístico
  serio (§8). Una sola ejecución no dice nada.
- **El simulador** (MuJoCo, Isaac, PyBullet o uno propio) es una dependencia de la tarea, no del arnés: lo aporta quien
  la plantea (§10).
- **Si el destino es un robot real,** pasar de la simulación a la realidad es la confirmación a ciegas definitiva, y
  ocurre fuera del sandbox.

**Lo que aporta frente a ajustar a mano o a una búsqueda ciega de hiperparámetros:**
- cada cambio de recompensa queda con su razón y su predicción;
- cuando una idea cae, se ven los cambios que dependían de ella (§9);
- ninguna mejora se da por buena hasta confirmarla en condiciones nuevas.

### 14.3 Un caso concreto: Microduck, el pato de Hugging Face (investigado el 14/10/2026)

El autor propone el robot pato de Hugging Face como juguete para validar §14.2. Lo que hay, según sus repositorios y la
prensa:

**El robot.** Microduck, de Pollen Robotics (comprada por Hugging Face en 2025), es la versión de producto del proyecto
abierto Open Duck Mini (Antoine Pirrone), una miniatura del droide BDX de Disney.
- Es un bípedo de unos 25 cm y menos de 800 g, con 14 o 15 servos (piernas, cuello, cabeza y un pico articulado).
- Su política neuronal corre a 50 Hz.
- Reservas a 399 $ desde agosto de 2026, con entregas previstas antes de Navidad.

**Dos gimnasios abiertos:**

| | `pollen-robotics/microduck_rl` | `apirrone/Open_Duck_Playground` |
|---|---|---|
| Simulador | mjlab (MuJoCo Warp) | MuJoCo, al estilo de MuJoCo Playground |
| Algoritmo | PPO (rsl_rl) | PPO |
| Entrenar | `uv run train Mjlab-Velocity-Flat-MicroDuck --env.scene.num-envs 4096` | `uv run playground/open_duck_mini_v2/runner.py --task flat_terrain_backlash --num_timesteps ...` |
| Coste | GPU CUDA; según el README, entre 1 y 2 horas para un andar usable con 4.096 entornos; o en Hugging Face Jobs (`--hf-jobs`), de pago | GPU; el README no da tiempos |
| Recompensas | `src/mjlab_microduck/tasks/mdp.py`, con reglas de diseño en `AGENTS.md` y pruebas de los signos de las recompensas | `common/rewards.py`, elegidas en `joystick.py`; recompensa opcional de imitación |
| Aleatorización | modelo de actuador (BAM, XL330) con voltaje de batería, caída de tensión, retardo de mando y fricción por entorno, conmutables con `ENABLE_*`; holgura de ±1° en las variantes `-Backlash` | `common/randomize.py` |
| Tareas | andar con mandos de velocidad y de cabeza (`Velocity-{Flat,Rough}`), levantarse, sentarse, recoger con el pico, chutar, patines... | andar con joystick, en terreno plano o irregular |
| Salida | ONNX (61 entradas → 14 objetivos articulares), normalizador incluido | ONNX |
| Licencia | código Apache 2.0; mallas 3D CC BY-NC-SA 4.0 | la página no lo indica |

**Por qué sirve para validar el mundo:**
- **La recompensa ya está separada en un archivo de código** (`mdp.py`): es el artefacto natural, y cambiarla es un parche.
- **Las familias de carga ya existen** como variantes de la tarea y como interruptores de aleatorización: plano frente a
  irregular, con y sin holgura, voltaje, retardo y fricción. Una combinación reservada, por ejemplo terreno irregular con
  holgura y retardo, es la confirmación a ciegas natural.
- **La tarea de andar con mandos de velocidad** da un score que no es la recompensa: el error de seguimiento de la
  velocidad mandada, más las caídas, sobre episodios de evaluación con mandos fijados por la tarea.

**Lo que tendríamos que poner nosotros:**
- **El score y el oráculo,** fuera del alcance del investigador. Un evaluador propio carga la política ONNX y la ejecuta en
  CPU (MuJoCo) sobre episodios fijados por la tarea:
  - el **score** es el error de seguimiento de la velocidad;
  - el **oráculo** pide no caerse, mantener los límites articulares y no sobrepasar un umbral de esfuerzo (con el modelo
    de actuador).

  La recompensa de entrenamiento nunca decide el veredicto.
- **Entrenamientos cortos para iterar:** con 1 o 2 horas por entrenamiento, el piloto tendría que usar presupuestos
  reducidos (menos pasos o menos entornos) y comparar versiones con el mismo presupuesto, varias semillas cada una.
  Validación y confirmación con presupuesto completo.
- **Fuera del repositorio:** el gimnasio se clona aparte, como las fuentes de EurekaBench. Su código es Apache 2.0, pero
  sus mallas son CC BY-NC-SA: nada suyo se copia al arnés.

**Lo que hay que resolver antes (preguntas para el autor):**
- **Hardware de entrenamiento:** hace falta una GPU NVIDIA con CUDA, o pagar Hugging Face Jobs. La máquina del autor tiene
  una RTX 3080 Ti con 12 GB: basta para entrenar en local, aunque quizá con menos de 4.096 entornos si no cabe en memoria.
  Instalar el entorno (uv, dependencias de mjlab) lo hace el usuario: no es una dependencia del arnés (§10, y la regla de
  no imponer dependencias).
- **Coste del piloto:** con presupuesto reducido y unas 3 semillas por versión, cada comparación tarda horas. ¿Cuántas
  versiones caben?
- **Qué tarea:** `Velocity-Flat` para empezar (la más simple, con score claro). Levantarse o chutar después.
- **Sin robot físico,** la confirmación a ciegas es en simulación con condiciones reservadas. Con un robot, el paso a la
  realidad sería la confirmación definitiva.

**Fuentes:**
- [pollen-robotics/microduck_rl](https://github.com/pollen-robotics/microduck_rl)
- [apirrone/Open_Duck_Playground](https://github.com/apirrone/Open_Duck_Playground)
- [Open Duck Mini (DeepWiki)](https://deepwiki.com/apirrone/Open_Duck_Mini)
- [The New Stack: Hugging Face Microduck](https://thenewstack.io/hugging-face-microduck-robot/?p=22834765)
- [AI Weekly: pre-orders for Microduck](https://aiweekly.co/alerts/hugging-face-opens-pre-orders-for-399-microduck-rl-biped)

Algunas cifras de la prensa no coinciden (procesador, sensores, número de servos). Las del entrenamiento salen de los
README de los repositorios.

## 15. Medidas y evaluación

- **Para el operador:**
  - mejora confirmada a ciegas y su intervalo;
  - versiones creadas;
  - ejecuciones gastadas;
  - predicciones registradas, cumplidas y fallidas;
  - cambios revertidos al caer su creencia;
  - tokens.
- **Comparaciones** emparejadas, con la misma tarea y el mismo presupuesto:
  - frente a un agente de código directo, sin protocolo;
  - frente a una búsqueda ciega, con mutaciones sin modelo;
  - con y sin el requisito de predicciones (`--own-tests`).
- **Qué sostendría la idea:** mejoras que se confirman a ciegas cuando las del agente directo no, o el mismo resultado con
  menos ejecuciones gracias al modelo.

## 16. Riesgos y preguntas abiertas

- **El coste:** es lento y caro comparado con un agente directo. Tiene sentido cuando equivocarse sale caro, o cuando la
  misma clase de tarea se repite muchas veces.
- **Aislar sin dependencias:** ¿con qué mecanismo del propio sistema operativo, y en qué sistemas? Hasta entonces, sólo artefactos de confianza (§10).
- **El ruido de medida** puede ser grande en máquinas compartidas. ¿Hace falta una máquina dedicada, o contar
  instrucciones en vez de tiempo?
- **Oráculos débiles:** si la corrección se decide con pocos tests, el artefacto puede sobreajustarse a ellos. ¿Generar
  también casos de corrección por familias, como las cargas?
- **Artefactos grandes:** un repositorio real no cabe entero en el contexto. Las observaciones (qué medir) y `view`/`diff`
  por trozos son la respuesta prevista. ¿Basta?
- **Tareas sin métrica de rendimiento** ("que haga X"): el veredicto sería sólo de corrección, y el modelo, de por qué la
  versión cumple. ¿Es otro mundo, o el mismo con métrica vacía?

## 17. Plan

1. **Sandbox mínimo** (procesos locales de Node y Python, sin dependencias) y artefacto versionado.
2. **El objetivo "optimizar"** con oráculo, repeticiones y criterio, y los actos `change`, `run` y `view`.
3. **El primer caso** (§14) con el investigador asistido y su senior. Piloto.
4. **Predicciones prerregistradas de cambios** (pruebas propias) y el vínculo cambio → creencias.
5. **`profile`** y los instrumentos propios sobre perfiles.
6. **Equipos y ramas.**
7. **Una automatización real** con APIs simuladas.

## 18. Implementado

### 18.1 El artefacto versionado y el sandbox mínimo (14/10/2026; plan, paso 1)

- **`lib/src/artifacts/store.ts` (`ArtifactStore`):**
  - la base se lee de un directorio (sin `.git`, `node_modules` ni `__pycache__`), con límites de archivos y bytes;
  - `apply(padre, parche)` crea una versión identificada por el hash de su contenido. El mismo contenido es la misma
    versión: volver a la base es la base;
  - un parche sustituye o quita archivos enteros (`{"files": {"<ruta>": "<contenido>" | null}}`);
  - rutas sólo dentro del artefacto: sin `..`, sin rutas absolutas ni unidades;
  - `materialize`, `diff` (añadidos, quitados, cambiados) y `view` (líneas numeradas).
- **`lib/src/artifacts/sandbox.ts`:** una interfaz (`Sandbox.run(artefacto, ejecución, límites)`) y un backend.
  - **Ejecución:** el comando, la entrada estándar, los archivos de la carga y los archivos de salida que se leen
    después.
  - **Resultado:** código de salida, si se pasó del tiempo, salida estándar y de error recortadas, salidas, tiempo de
    pared y, donde se mide, CPU y memoria máxima. Dice siempre qué backend lo ejecutó y si estaba aislado.
  - **`process` (NO aislado):** un proceso local con el artefacto copiado junto a la carga y un entorno vacío (sólo lo
    que encuentra el runtime: ninguna clave del anfitrión). Mide sólo el tiempo de pared. Es para desarrollo y para las
    pruebas del arnés con artefactos propios.
  - Hubo un backend de Docker (aislado, con medidas del cgroup). Se quitó a petición del autor: el arnés no depende de
    Docker.
- **Pruebas** (`test/artifacts.test.ts`):
  - **Versiones:** por contenido, rechazos, `diff`, `view` y `materialize`.
  - **El backend de procesos:** entrada, salidas, entrada estándar, sin secretos del anfitrión, y el límite de tiempo.

### 18.2 Revisión externa (14/10/2026)

- **Rutas en una sola forma:** `./a.txt` es `a.txt`. Antes eran dos entradas que se escribían en el mismo archivo: `view`
  mostraba una y se ejecutaba la otra, y reconstruir el artefacto daba otro hash.
- **Colisiones rechazadas:** en un parche, en una versión y en una base se rechazan dos nombres que un sistema de
  archivos sin distinción de mayúsculas escribiría como uno.
- **§7 corregido:** el percepto sólo lleva lo que se sabe antes de ejecutar, y las métricas son lo que salió.
